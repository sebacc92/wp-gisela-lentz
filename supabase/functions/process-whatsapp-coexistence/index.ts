import {
  coexistenceOperations,
  type CoexistenceBatch,
  type CoexistenceMessageOperation,
  type CoexistenceOperation,
} from "../_shared/whatsapp-coexistence.ts";
import { jsonResponse, safeErrorMessage } from "../_shared/http.ts";
import { authorizeProcessorRequest } from "../_shared/recovery-auth.ts";
import { createServiceClient, getServiceKey } from "../_shared/supabase.ts";
import { type MetaValue } from "../_shared/whatsapp-webhook.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

interface QueuedCoexistenceEvent {
  id: string;
  account_id: string;
  external_event_id: string;
  field: string;
  payload: MetaValue;
  cursor: Record<string, unknown> | null;
  lease_token: string;
}

interface ProcessingResult {
  completed: boolean;
  yielded: boolean;
  processedItems: number;
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(Deno.env.get(name));
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function requiredRpcResult<T>(
  operation: string,
  result: { data: unknown; error: { message: string } | null },
): T {
  if (result.error) throw new Error(`${operation}:${result.error.message}`);
  const value = Array.isArray(result.data) ? result.data[0] : result.data;
  if (value === null || value === undefined) {
    throw new Error(`${operation}:NO_RESULT`);
  }
  return value as T;
}

function cursorIndex(
  cursor: Record<string, unknown> | null,
  operationCount: number,
): number {
  const raw = cursor?.operation_index;
  if (raw === undefined) return 0;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > operationCount
  ) {
    throw new Error("INVALID_COEXISTENCE_CURSOR");
  }
  return raw;
}

function batchExternalId(
  event: QueuedCoexistenceEvent,
  batch: CoexistenceBatch,
): string {
  return `${event.external_event_id}:${batch.externalBatchId}`.slice(0, 240);
}

async function upsertBatch(
  client: SupabaseClient,
  event: QueuedCoexistenceEvent,
  batch: CoexistenceBatch,
  status: "processing" | "completed" | "failed",
  processedCount: number,
  failedCount = 0,
  error: string | null = null,
): Promise<{ id: string }> {
  return requiredRpcResult<{ id: string }>(
    "COEXISTENCE_BATCH_FAILED",
    await client.rpc("upsert_whatsapp_coexistence_sync_batch", {
      p_account_id: event.account_id,
      p_event_id: event.id,
      p_lease_token: event.lease_token,
      p_external_batch_id: batchExternalId(event, batch),
      p_sync_type: batch.syncType,
      p_phase: batch.phase,
      p_chunk_order: batch.chunkOrder,
      p_progress: batch.progress,
      p_status: status,
      p_item_count: batch.itemCount,
      p_processed_count: processedCount,
      p_failed_count: failedCount,
      p_error: error,
      p_metadata: batch.metadata,
    }),
  );
}

async function ingestMessage(
  client: SupabaseClient,
  event: QueuedCoexistenceEvent,
  operation: CoexistenceMessageOperation,
  batchId: string | null,
): Promise<void> {
  if (operation.metadata.media_follow_up === true) {
    const result = await client.rpc("ingest_whatsapp_history_media_followup", {
      p_account_id: event.account_id,
      p_event_id: event.id,
      p_lease_token: event.lease_token,
      p_whatsapp_message_id: operation.externalMessageId,
      p_message_type: operation.metadata.content_type,
      p_body: operation.body,
      p_metadata: operation.metadata,
    });
    if (result.error) {
      throw new Error(`HISTORY_MEDIA_INGEST_FAILED:${result.error.message}`);
    }
    return;
  }

  if (!operation.contactPhoneE164 && !operation.contactWhatsAppUserId) {
    throw new Error("INVALID_COEXISTENCE_MESSAGE_CONTACT");
  }
  requiredRpcResult(
    "COEXISTENCE_MESSAGE_INGEST_FAILED",
    await client.rpc("ingest_whatsapp_coexistence_message", {
      p_account_id: event.account_id,
      p_event_id: event.id,
      p_lease_token: event.lease_token,
      p_batch_id: batchId,
      p_source: operation.source,
      p_whatsapp_message_id: operation.externalMessageId,
      p_contact_phone_e164: operation.contactPhoneE164,
      p_contact_whatsapp_id: operation.contactWhatsAppId,
      p_contact_user_id: operation.contactWhatsAppUserId,
      p_contact_name: operation.contactName,
      p_direction: operation.direction,
      p_message_type: operation.messageType,
      p_body: operation.body,
      p_status: operation.status,
      p_message_at: operation.messageAt,
      p_original_whatsapp_message_id: operation.originalMessageId,
      p_metadata: {
        ...operation.metadata,
        stored_type: operation.storedType,
      },
    }),
  );
}

function historyErrorBatch(
  event: QueuedCoexistenceEvent,
  operation: Extract<CoexistenceOperation, { kind: "history_error" }>,
): CoexistenceBatch {
  const errorCode = operation.code === null ? "unknown" : operation.code;
  return {
    externalBatchId: `history:error:${operation.errorIndex}:${errorCode}`,
    syncType: "history",
    phase: null,
    chunkOrder: null,
    progress: null,
    itemCount: 1,
    metadata: {
      source_event_id: event.external_event_id,
      error_code: operation.code,
      ...operation.metadata,
    },
  };
}

function stateSyncBatch(
  event: QueuedCoexistenceEvent,
  itemCount: number,
): CoexistenceBatch {
  return {
    externalBatchId: "app-state:event",
    syncType: "smb_app_state_sync",
    phase: null,
    chunkOrder: null,
    progress: null,
    itemCount,
    metadata: { source_event_id: event.external_event_id },
  };
}

async function processOperation(
  client: SupabaseClient,
  event: QueuedCoexistenceEvent,
  operation: CoexistenceOperation,
  batchIds: Map<string, string>,
  batchProcessed: Map<string, number>,
): Promise<void> {
  if (operation.kind === "batch") {
    const key = batchExternalId(event, operation.batch);
    const isEmpty = operation.batch.itemCount === 0;
    const row = await upsertBatch(
      client,
      event,
      operation.batch,
      isEmpty ? "completed" : "processing",
      0,
    );
    batchIds.set(key, row.id);
    batchProcessed.set(key, 0);
    return;
  }

  if (operation.kind === "contact") {
    const result = await client.rpc("ingest_whatsapp_coexistence_contact", {
      p_account_id: event.account_id,
      p_event_id: event.id,
      p_lease_token: event.lease_token,
      p_action: operation.action,
      p_phone_e164: operation.phoneE164,
      p_whatsapp_id: operation.whatsappId,
      p_whatsapp_user_id: operation.whatsappUserId,
      p_full_name: operation.fullName,
      p_source_timestamp: operation.sourceTimestamp,
      p_metadata: operation.metadata,
    });
    if (result.error) {
      throw new Error(
        `COEXISTENCE_CONTACT_INGEST_FAILED:${result.error.message}`,
      );
    }
    return;
  }

  if (operation.kind === "history_error") {
    const message = [operation.title, operation.message]
      .filter(Boolean)
      .join(": ")
      .slice(0, 2000);
    await upsertBatch(
      client,
      event,
      historyErrorBatch(event, operation),
      "failed",
      0,
      1,
      message,
    );
    return;
  }

  let batchId: string | null = null;
  if (operation.batch) {
    const key = batchExternalId(event, operation.batch);
    batchId = batchIds.get(key) ?? null;
    if (!batchId) {
      const processed = batchProcessed.get(key) ?? 0;
      const row = await upsertBatch(
        client,
        event,
        operation.batch,
        "processing",
        processed,
      );
      batchId = row.id;
      batchIds.set(key, batchId);
    }
  }

  await ingestMessage(client, event, operation, batchId);

  if (operation.batch) {
    const key = batchExternalId(event, operation.batch);
    const processed = (batchProcessed.get(key) ?? 0) + 1;
    batchProcessed.set(key, processed);
    if (processed >= operation.batch.itemCount) {
      await upsertBatch(
        client,
        event,
        operation.batch,
        "completed",
        operation.batch.itemCount,
      );
    }
  }
}

function initializeBatchProgress(
  operations: CoexistenceOperation[],
  startIndex: number,
): Map<string, number> {
  const progress = new Map<string, number>();
  for (let index = 0; index < startIndex; index += 1) {
    const operation = operations[index];
    if (operation?.kind !== "message" || !operation.batch) continue;
    progress.set(
      operation.batch.externalBatchId,
      (progress.get(operation.batch.externalBatchId) ?? 0) + 1,
    );
  }
  return progress;
}

async function checkpoint(
  client: SupabaseClient,
  event: QueuedCoexistenceEvent,
  operationIndex: number,
  operationCount: number,
): Promise<void> {
  const result = await client.rpc("checkpoint_whatsapp_coexistence_event", {
    p_event_id: event.id,
    p_lease_token: event.lease_token,
    p_cursor: {
      operation_index: operationIndex,
      total_operations: operationCount,
    },
  });
  if (result.error || result.data !== true) {
    throw new Error(
      `COEXISTENCE_CHECKPOINT_FAILED:${result.error?.message ?? "LEASE_LOST"}`,
    );
  }
  event.cursor = {
    ...(event.cursor ?? {}),
    operation_index: operationIndex,
    total_operations: operationCount,
  };
}

async function processEvent(
  client: SupabaseClient,
  event: QueuedCoexistenceEvent,
  maximumItems: number,
): Promise<ProcessingResult> {
  const operations = coexistenceOperations(event.field, event.payload);
  const startIndex = cursorIndex(event.cursor, operations.length);
  const stopIndex = Math.min(operations.length, startIndex + maximumItems);
  const batchIds = new Map<string, string>();
  const rawProgress = initializeBatchProgress(operations, startIndex);
  const batchProcessed = new Map<string, number>();
  for (const [batchId, count] of rawProgress) {
    batchProcessed.set(
      `${event.external_event_id}:${batchId}`.slice(0, 240),
      count,
    );
  }

  let syntheticStateBatch: CoexistenceBatch | null = null;
  if (event.field === "smb_app_state_sync") {
    syntheticStateBatch = stateSyncBatch(event, operations.length);
    await upsertBatch(
      client,
      event,
      syntheticStateBatch,
      operations.length ? "processing" : "completed",
      startIndex,
    );
  }

  for (let index = startIndex; index < stopIndex; index += 1) {
    const operation = operations[index];
    if (!operation) throw new Error("INVALID_COEXISTENCE_OPERATION_INDEX");
    await processOperation(client, event, operation, batchIds, batchProcessed);
    const nextIndex = index + 1;

    if (syntheticStateBatch && nextIndex === operations.length) {
      await upsertBatch(
        client,
        event,
        syntheticStateBatch,
        "completed",
        operations.length,
      );
    }

    if (nextIndex < operations.length) {
      await checkpoint(client, event, nextIndex, operations.length);
    }
  }

  if (stopIndex < operations.length) {
    const result = await client.rpc("yield_whatsapp_coexistence_event", {
      p_event_id: event.id,
      p_lease_token: event.lease_token,
      p_cursor: {
        operation_index: stopIndex,
        total_operations: operations.length,
      },
    });
    if (result.error || result.data !== true) {
      throw new Error(
        `COEXISTENCE_YIELD_FAILED:${result.error?.message ?? "LEASE_LOST"}`,
      );
    }
    return {
      completed: false,
      yielded: true,
      processedItems: stopIndex - startIndex,
    };
  }

  const result = await client.rpc("complete_whatsapp_coexistence_event", {
    p_event_id: event.id,
    p_lease_token: event.lease_token,
    p_cursor: {
      operation_index: operations.length,
      total_operations: operations.length,
    },
  });
  if (result.error || result.data !== true) {
    throw new Error(
      `COEXISTENCE_COMPLETION_FAILED:${result.error?.message ?? "LEASE_LOST"}`,
    );
  }
  return {
    completed: true,
    yielded: false,
    processedItems: stopIndex - startIndex,
  };
}

function shouldRetry(error: unknown): boolean {
  const code = safeErrorMessage(error).toUpperCase();
  return !(
    code.includes("INVALID_") ||
    code.includes("UNSUPPORTED_") ||
    code.includes("IDENTITY_CONFLICT") ||
    code.includes("ID_COLLISION")
  );
}

async function failEvent(
  client: SupabaseClient,
  event: QueuedCoexistenceEvent,
  error: unknown,
): Promise<void> {
  const result = await client.rpc("fail_whatsapp_coexistence_event", {
    p_event_id: event.id,
    p_lease_token: event.lease_token,
    p_error: safeErrorMessage(error).slice(0, 2000),
    p_retry: shouldRetry(error),
    p_cursor: event.cursor ?? {},
  });
  if (result.error) {
    console.error("Coexistence failure could not be persisted", {
      eventId: event.id,
      code: result.error.message,
    });
  }
}

async function scheduleAnotherRun(secret: string): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  if (!url || !secret) return;
  const task = fetch(`${url}/functions/v1/process-whatsapp-coexistence`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getServiceKey()}`,
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: "{}",
  }).then((response) => {
    if (!response.ok) {
      console.error("Coexistence continuation invocation failed", {
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

  const expectedInternalSecret =
    Deno.env.get("WHATSAPP_COEXISTENCE_INTERNAL_SECRET")?.trim() ?? "";
  const expectedRecoverySecret =
    Deno.env.get("WHATSAPP_COEXISTENCE_RECOVERY_SECRET")?.trim() ?? "";
  if (
    !(await authorizeProcessorRequest(
      request,
      expectedInternalSecret,
      expectedRecoverySecret,
    ))
  ) {
    return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
  }

  const claimLimit = boundedInteger(
    "WHATSAPP_COEXISTENCE_CLAIM_LIMIT",
    5,
    1,
    25,
  );
  const itemLimit = boundedInteger(
    "WHATSAPP_COEXISTENCE_ITEMS_PER_RUN",
    100,
    1,
    500,
  );
  const client = createServiceClient();
  const claimedResult = await client.rpc("claim_whatsapp_coexistence_events", {
    p_limit: claimLimit,
  });
  if (claimedResult.error) {
    console.error("Coexistence queue claim failed", {
      code: claimedResult.error.message,
    });
    return jsonResponse(request, { error: "QUEUE_CLAIM_FAILED" }, 500);
  }

  const events = (claimedResult.data ?? []) as QueuedCoexistenceEvent[];
  let completed = 0;
  let yielded = 0;
  let failed = 0;
  let processedItems = 0;

  for (const event of events) {
    try {
      const result = await processEvent(client, event, itemLimit);
      completed += result.completed ? 1 : 0;
      yielded += result.yielded ? 1 : 0;
      processedItems += result.processedItems;
    } catch (error) {
      failed += 1;
      await failEvent(client, event, error);
      console.error("Coexistence event processing failed", {
        eventId: event.id,
        field: event.field,
        code: safeErrorMessage(error),
      });
    }
  }

  // The SQL claim deliberately leases one account per pass to preserve stream
  // order. Any non-empty claim therefore schedules an empty-check pass so a
  // second account cannot wait for the recovery cron.
  if (events.length > 0) {
    await scheduleAnotherRun(expectedInternalSecret);
  }

  return jsonResponse(request, {
    processed: true,
    claimed: events.length,
    completed,
    yielded,
    failed,
    processedItems,
  });
});
