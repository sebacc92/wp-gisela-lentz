import { jsonResponse, safeErrorMessage } from "../_shared/http.ts";
import { createServiceClient, getServiceKey } from "../_shared/supabase.ts";
import { constantTimeEqual } from "../_shared/whatsapp-webhook.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

interface AutomationDispatch {
  id: string;
  message_id: string;
  lease_token: string;
}

function claimLimit(): number {
  const parsed = Number(Deno.env.get("WHATSAPP_AUTOMATION_OUTBOX_CLAIM_LIMIT"));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : 10;
}

async function invokeAutomation(messageId: string): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const secret = Deno.env.get("AUTOMATION_INTERNAL_SECRET")?.trim();
  if (!url || !secret) throw new Error("AUTOMATION_CONFIGURATION_INCOMPLETE");

  const response = await fetch(`${url}/functions/v1/whatsapp-automation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getServiceKey()}`,
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify({ messageId }),
  });
  if (!response.ok) {
    throw new Error(`AUTOMATION_INVOCATION_FAILED:${response.status}`);
  }
}

async function completeDispatch(
  client: SupabaseClient,
  dispatch: AutomationDispatch,
): Promise<void> {
  const result = await client.rpc("complete_whatsapp_automation_dispatch", {
    p_id: dispatch.id,
    p_lease_token: dispatch.lease_token,
  });
  if (result.error || result.data !== true) {
    throw new Error(
      `AUTOMATION_DISPATCH_COMPLETION_FAILED:${result.error?.message ?? "LEASE_LOST"}`,
    );
  }
}

async function failDispatch(
  client: SupabaseClient,
  dispatch: AutomationDispatch,
  error: unknown,
): Promise<void> {
  const result = await client.rpc("fail_whatsapp_automation_dispatch", {
    p_id: dispatch.id,
    p_lease_token: dispatch.lease_token,
    p_error: safeErrorMessage(error),
    p_retry: true,
  });
  if (result.error) {
    console.error("Automation outbox failure could not be persisted", {
      dispatchId: dispatch.id,
      code: result.error.message,
    });
  }
}

async function scheduleAnotherRun(secret: string): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  if (!url) return;
  const task = fetch(`${url}/functions/v1/process-whatsapp-automation-outbox`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getServiceKey()}`,
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: "{}",
  }).then((response) => {
    if (!response.ok) {
      console.error("Automation outbox continuation invocation failed", {
        status: response.status,
      });
    }
  });
  const runtime = (
    globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }
  ).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
  else await task;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const expectedSecret = Deno.env.get("AUTOMATION_INTERNAL_SECRET")?.trim();
  const providedSecret = request.headers.get("x-internal-secret")?.trim() ?? "";
  if (!expectedSecret || !constantTimeEqual(providedSecret, expectedSecret)) {
    return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
  }

  const limit = claimLimit();
  const client = createServiceClient();
  const claimed = await client.rpc("claim_whatsapp_automation_dispatches", {
    p_limit: limit,
  });
  if (claimed.error) {
    console.error("Automation outbox claim failed", {
      code: claimed.error.message,
    });
    return jsonResponse(request, { error: "QUEUE_CLAIM_FAILED" }, 500);
  }

  const dispatches = (claimed.data ?? []) as AutomationDispatch[];
  let completed = 0;
  let failed = 0;

  for (const dispatch of dispatches) {
    try {
      await invokeAutomation(dispatch.message_id);
      await completeDispatch(client, dispatch);
      completed += 1;
    } catch (error) {
      failed += 1;
      await failDispatch(client, dispatch, error);
      console.error("Automation outbox dispatch failed", {
        dispatchId: dispatch.id,
        messageId: dispatch.message_id,
        code: safeErrorMessage(error),
      });
    }
  }

  // Completing the earliest message can unblock the next reserved/pending
  // message in the same conversation even when this claim was below `limit`.
  // One follow-up pass drains that newly-actionable work without waiting for
  // the recovery cron (an empty pass stops the chain).
  if (dispatches.length > 0) await scheduleAnotherRun(expectedSecret);

  return jsonResponse(request, {
    processed: true,
    claimed: dispatches.length,
    completed,
    failed,
  });
});
