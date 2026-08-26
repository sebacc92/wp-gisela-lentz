import {
  type CoexistenceBatch,
  type CoexistenceMessageOperation,
  type CoexistenceOperation,
  coexistenceOperations,
} from "../_shared/whatsapp-coexistence.ts";
import { jsonResponse, safeErrorMessage } from "../_shared/http.ts";
import { authorizeProcessorRequest } from "../_shared/recovery-auth.ts";
import { createServiceClient, getServiceKey } from "../_shared/supabase.ts";
import { type MetaValue } from "../_shared/whatsapp-webhook.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  canStartOnboardingGraphJob,
  classifyEmbeddedSignupCompletionFailure,
  assertBusinessTokenAuthorization,
  assertBusinessTokenLifetime,
  type BusinessTokenMetadata,
  type EmbeddedSignupConfiguration,
  embeddedSignupConfiguration,
  ensureAppSubscribed,
  inspectBusinessToken,
  MetaEmbeddedSignupError,
  requestAppDataSync,
  safeEmbeddedSignupErrorCode,
  type SyncRequestAcceptance,
  unsubscribeApp,
  validateWhatsAppAssets,
  whatsappEmbeddedSignupEnabled,
} from "../_shared/whatsapp-embedded-signup.ts";
import {
  isWhatsAppCredentialResolutionError,
  resolveWhatsAppAccountCredentials,
} from "../_shared/whatsapp-account-credentials.ts";
import { markWhatsAppCredentialAttentionRequired } from "../_shared/whatsapp.ts";

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

export interface OnboardingJob {
  id: string;
  account_id: string;
  token_generation: number;
  operation:
    | "subscribe_app"
    | "request_contacts_sync"
    | "request_history_sync"
    | "unsubscribe_app";
  deadline_at: string | null;
  lease_token: string;
}

export interface OnboardingGraphOperations {
  configuration: () => EmbeddedSignupConfiguration;
  ensureSubscribed: typeof ensureAppSubscribed;
  requestSync: typeof requestAppDataSync;
  unsubscribe: typeof unsubscribeApp;
  now: () => number;
}

const defaultOnboardingGraphOperations: OnboardingGraphOperations = {
  configuration: () =>
    embeddedSignupConfiguration((name) => Deno.env.get(name)),
  ensureSubscribed: ensureAppSubscribed,
  requestSync: requestAppDataSync,
  unsubscribe: unsubscribeApp,
  now: Date.now,
};

export interface EmbeddedSignupValidationJob {
  attempt_id: string;
  initiated_by: string;
  validation_lease_token: string;
  business_access_token: string;
  submitted_business_portfolio_id: string | null;
  submitted_waba_id: string;
  submitted_phone_number_id: string | null;
  history_sharing_decision: "accepted" | "declined";
  validation_deadline_at: string;
  validation_attempts: number;
}

interface BusinessTokenValidationJob {
  id: string;
  account_id: string;
  token_generation: number;
  lease_token: string;
}

async function recordPreCompletionValidation(input: {
  client: SupabaseClient;
  attemptId: string;
  validationLeaseToken: string;
  metadata: BusinessTokenMetadata;
  errorCode: string | null;
}): Promise<void> {
  const result = await input.client.rpc(
    "record_whatsapp_embedded_signup_pre_completion_validation",
    {
      p_attempt_id: input.attemptId,
      p_validation_lease_token: input.validationLeaseToken,
      p_token_is_valid: input.metadata.isValid,
      p_token_app_id: input.metadata.appId,
      p_token_scopes: input.metadata.scopes,
      p_token_granular_scopes: input.metadata.granularScopes.map((scope) => ({
        scope: scope.scope,
        target_ids: scope.targetIds,
      })),
      p_token_target_ids: input.metadata.targetIds,
      p_token_expires_at: input.metadata.expiresAt,
      p_token_data_access_expires_at: input.metadata.dataAccessExpiresAt,
      p_token_validated_at: input.metadata.validatedAt,
      p_error_code: input.errorCode,
    },
  );
  if (result.error || result.data !== true) {
    throw new Error("WHATSAPP_EMBEDDED_PRE_COMPLETION_PERSIST_FAILED");
  }
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

function firstRpcRow<T>(data: unknown): T | null {
  const value = Array.isArray(data) ? data[0] : data;
  return value === null || value === undefined ? null : (value as T);
}

async function failBusinessTokenValidation(
  client: SupabaseClient,
  job: BusinessTokenValidationJob,
  error: unknown,
): Promise<"retrying" | "failed" | "stale"> {
  const retryable =
    error instanceof MetaEmbeddedSignupError
      ? error.retryable && !error.outcomeUnknown
      : true;
  const result = await client.rpc(
    "fail_whatsapp_business_token_validation_job",
    {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_error_code: safeEmbeddedSignupErrorCode(error),
      p_retryable: retryable,
    },
  );
  if (result.error) {
    throw new Error("WHATSAPP_TOKEN_VALIDATION_FAILURE_PERSIST_FAILED");
  }
  if (
    result.data !== "retrying" &&
    result.data !== "failed" &&
    result.data !== "stale"
  ) {
    throw new Error("WHATSAPP_TOKEN_VALIDATION_FAILURE_RESULT_INVALID");
  }
  return result.data;
}

async function processBusinessTokenValidation(
  client: SupabaseClient,
  job: BusinessTokenValidationJob,
): Promise<"rescheduled" | "invalid" | "stale"> {
  const credentials = await resolveWhatsAppAccountCredentials({
    client,
    purpose: "token_validation",
    coexistenceAccountId: job.account_id,
    expectedTokenGeneration: job.token_generation,
  });
  if (
    credentials.credentialMode !== "coexistence" ||
    credentials.accountId !== job.account_id ||
    credentials.tokenGeneration !== job.token_generation
  ) {
    throw new MetaEmbeddedSignupError(
      "WHATSAPP_TOKEN_VALIDATION_CONTEXT_INVALID",
      { status: 409 },
    );
  }
  const config = embeddedSignupConfiguration((name) => Deno.env.get(name));
  const metadata = await inspectBusinessToken({
    businessToken: credentials.businessAccessToken,
    config,
  });
  let authorizationError: string | null = null;
  try {
    assertBusinessTokenAuthorization({
      metadata,
      expectedAppId: config.appId,
      expectedWabaId: credentials.wabaId,
    });
  } catch (error) {
    authorizationError = safeEmbeddedSignupErrorCode(error);
  }
  const completion = await client.rpc(
    "complete_whatsapp_business_token_validation_job",
    {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_token_is_valid: metadata.isValid,
      p_token_app_id: metadata.appId,
      p_token_scopes: metadata.scopes,
      p_token_granular_scopes: metadata.granularScopes.map((scope) => ({
        scope: scope.scope,
        target_ids: scope.targetIds,
      })),
      p_token_target_ids: metadata.targetIds,
      p_token_expires_at: metadata.expiresAt,
      p_token_data_access_expires_at: metadata.dataAccessExpiresAt,
      p_token_validated_at: metadata.validatedAt,
      p_error_code: authorizationError,
    },
  );
  if (completion.error) {
    throw new Error("WHATSAPP_TOKEN_VALIDATION_COMPLETION_FAILED");
  }
  if (
    completion.data !== "rescheduled" &&
    completion.data !== "invalid" &&
    completion.data !== "stale"
  ) {
    throw new Error("WHATSAPP_TOKEN_VALIDATION_COMPLETION_INVALID");
  }
  return completion.data;
}

async function persistValidationFailure(
  client: SupabaseClient,
  job: EmbeddedSignupValidationJob,
  error: unknown,
): Promise<"retrying" | "failed" | "stale"> {
  const retryable = shouldRetryEmbeddedSignupValidation(error);
  const result = await client.rpc("fail_whatsapp_embedded_signup_validation", {
    p_attempt_id: job.attempt_id,
    p_validation_lease_token: job.validation_lease_token,
    p_error_code: safeEmbeddedSignupErrorCode(error),
    p_retryable: retryable,
  });
  if (result.error) {
    throw new Error("WHATSAPP_EMBEDDED_VALIDATION_FAILURE_PERSIST_FAILED");
  }
  if (
    result.data !== "retrying" &&
    result.data !== "failed" &&
    result.data !== "stale"
  ) {
    throw new Error("WHATSAPP_EMBEDDED_VALIDATION_FAILURE_RESULT_INVALID");
  }
  return result.data;
}

export function shouldRetryEmbeddedSignupValidation(error: unknown): boolean {
  return error instanceof MetaEmbeddedSignupError
    ? error.retryable && !error.outcomeUnknown
    : true;
}

export async function processEmbeddedSignupValidation(
  client: SupabaseClient,
  job: EmbeddedSignupValidationJob,
): Promise<"completed" | "rejected"> {
  if (
    !job.business_access_token ||
    !job.submitted_waba_id ||
    new Date(job.validation_deadline_at).getTime() <= Date.now()
  ) {
    throw new MetaEmbeddedSignupError(
      "WHATSAPP_EMBEDDED_SIGNUP_VALIDATION_CONTEXT_INVALID",
      { status: 409 },
    );
  }
  const config = embeddedSignupConfiguration((name) => Deno.env.get(name));
  const tokenMetadata = await inspectBusinessToken({
    businessToken: job.business_access_token,
    config,
  });
  let authorizationError: unknown = null;
  try {
    assertBusinessTokenAuthorization({
      metadata: tokenMetadata,
      expectedAppId: config.appId,
      expectedWabaId: job.submitted_waba_id,
    });
    assertBusinessTokenLifetime(tokenMetadata, 15 * 60 * 1_000);
  } catch (error) {
    authorizationError = error;
  }
  await recordPreCompletionValidation({
    client,
    attemptId: job.attempt_id,
    validationLeaseToken: job.validation_lease_token,
    metadata: tokenMetadata,
    errorCode:
      authorizationError === null
        ? null
        : safeEmbeddedSignupErrorCode(authorizationError),
  });
  if (authorizationError !== null) return "rejected";

  const assets = await validateWhatsAppAssets({
    businessToken: job.business_access_token,
    expectedWabaId: job.submitted_waba_id,
    expectedPhoneNumberId: job.submitted_phone_number_id,
    expectedBusinessPortfolioId: job.submitted_business_portfolio_id,
    config,
    inspectedTokenMetadata: tokenMetadata,
  });
  const completion = await client.rpc("complete_whatsapp_embedded_signup", {
    p_attempt_id: job.attempt_id,
    p_admin_user_id: job.initiated_by,
    p_verified_business_portfolio_id: assets.businessPortfolioId,
    p_verified_waba_id: assets.wabaId,
    p_verified_phone_number_id: assets.phoneNumberId,
    p_display_phone: assets.displayPhoneNumber,
    p_token_is_valid: assets.tokenMetadata.isValid,
    p_token_app_id: assets.tokenMetadata.appId,
    p_token_scopes: assets.tokenMetadata.scopes,
    p_token_granular_scopes: assets.tokenMetadata.granularScopes.map(
      (scope) => ({ scope: scope.scope, target_ids: scope.targetIds }),
    ),
    p_token_target_ids: assets.tokenMetadata.targetIds,
    p_token_expires_at: assets.tokenMetadata.expiresAt,
    p_token_data_access_expires_at: assets.tokenMetadata.dataAccessExpiresAt,
    p_token_validated_at: assets.tokenMetadata.validatedAt,
    p_validation_lease_token: job.validation_lease_token,
  });
  if (completion.error) {
    const failure = classifyEmbeddedSignupCompletionFailure(completion.error);
    throw new MetaEmbeddedSignupError(failure.code, {
      status: failure.status,
      retryable: failure.retryable,
    });
  }
  if (!firstRpcRow(completion.data)) {
    throw new Error("WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_FAILED");
  }
  return "completed";
}

async function finishOnboardingJob(
  client: SupabaseClient,
  job: OnboardingJob,
  remoteRequestId: string | null,
  completionReason:
    | "remote_confirmed"
    | "already_applied"
    | "remote_already_absent",
): Promise<void> {
  const result = await client.rpc("complete_whatsapp_onboarding_job", {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_remote_request_id: remoteRequestId,
    p_completion_reason: completionReason,
  });
  if (result.error || result.data !== true) {
    const isOneShotSync =
      job.operation === "request_contacts_sync" ||
      job.operation === "request_history_sync";
    throw new MetaEmbeddedSignupError(
      isOneShotSync
        ? "WHATSAPP_SYNC_COMPLETION_OUTCOME_UNKNOWN"
        : "WHATSAPP_SUBSCRIPTION_COMPLETION_RETRY_REQUIRED",
      {
        status: 500,
        retryable: !isOneShotSync,
        outcomeUnknown: isOneShotSync,
      },
    );
  }
}

export async function persistOnboardingJobFailure(
  client: SupabaseClient,
  job: OnboardingJob,
  error: unknown,
): Promise<void> {
  const metaError =
    error instanceof MetaEmbeddedSignupError ? error : undefined;
  const credentialError = isWhatsAppCredentialResolutionError(error)
    ? error
    : undefined;
  const result = await client.rpc("fail_whatsapp_onboarding_job", {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error_code: credentialError?.code ?? safeEmbeddedSignupErrorCode(error),
    p_outcome: metaError?.outcomeUnknown ? "ambiguous" : "definitive",
    p_retryable:
      (metaError?.retryable === true && !metaError.outcomeUnknown) ||
      credentialError?.retryable === true,
  });
  if (result.error) {
    console.error("Onboarding failure could not be persisted", {
      jobId: job.id,
      operation: job.operation,
      code: "WHATSAPP_ONBOARDING_FAILURE_PERSIST_FAILED",
    });
  }
}

export async function finalizeLocalOffboardingForInvalidCredential(
  client: SupabaseClient,
  job: OnboardingJob,
  error: MetaEmbeddedSignupError,
): Promise<boolean> {
  if (job.operation !== "unsubscribe_app" || !error.credentialInvalid) {
    return false;
  }
  const result = await client.rpc(
    "finalize_whatsapp_coexistence_local_offboarding",
    {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_reason:
        error.code === "WHATSAPP_BUSINESS_CREDENTIAL_EXPIRED"
          ? "TOKEN_EXPIRED"
          : "CREDENTIAL_INVALID",
    },
  );
  if (result.error || result.data !== true) {
    throw new Error("WHATSAPP_LOCAL_OFFBOARDING_FINALIZATION_FAILED");
  }
  return true;
}

export async function processOnboardingJob(
  client: SupabaseClient,
  job: OnboardingJob,
  graph: OnboardingGraphOperations = defaultOnboardingGraphOperations,
): Promise<void> {
  const credentials = await resolveWhatsAppAccountCredentials({
    client,
    purpose: job.operation === "unsubscribe_app" ? "unsubscribe" : "onboarding",
    coexistenceAccountId: job.account_id,
    expectedTokenGeneration: job.token_generation,
  });
  if (
    credentials.credentialMode !== "coexistence" ||
    credentials.accountId !== job.account_id ||
    credentials.tokenGeneration !== job.token_generation
  ) {
    throw new MetaEmbeddedSignupError(
      "WHATSAPP_BUSINESS_CREDENTIAL_UNAVAILABLE",
      { status: 503, retryable: true },
    );
  }
  if (!canStartOnboardingGraphJob(job.deadline_at, graph.now())) {
    throw new MetaEmbeddedSignupError("SYNC_WINDOW_TOO_CLOSE", {
      status: 409,
    });
  }

  const config = graph.configuration();
  const common = {
    businessToken: credentials.businessAccessToken,
    config,
  };
  const graphOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MetaEmbeddedSignupError && error.credentialInvalid) {
        await markWhatsAppCredentialAttentionRequired({
          client,
          credentials,
        });
      }
      throw error;
    }
  };
  if (job.operation === "subscribe_app") {
    const result = await graphOperation(() =>
      graph.ensureSubscribed({
        ...common,
        wabaId: credentials.wabaId,
      }),
    );
    await finishOnboardingJob(
      client,
      job,
      null,
      result.alreadySubscribed ? "already_applied" : "remote_confirmed",
    );
    return;
  }
  if (job.operation === "unsubscribe_app") {
    const result = await graphOperation(() =>
      graph.unsubscribe({
        ...common,
        wabaId: credentials.wabaId,
      }),
    );
    await finishOnboardingJob(
      client,
      job,
      null,
      result.alreadyUnsubscribed ? "remote_already_absent" : "remote_confirmed",
    );
    return;
  }

  const accepted: SyncRequestAcceptance = await graphOperation(() =>
    graph.requestSync({
      ...common,
      phoneNumberId: credentials.phoneNumberId,
      syncType:
        job.operation === "request_contacts_sync"
          ? "smb_app_state_sync"
          : "history",
    }),
  );
  await finishOnboardingJob(
    client,
    job,
    accepted.requestId,
    "remote_confirmed",
  );
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

export async function handleWhatsAppCoexistenceProcessorRequest(
  request: Request,
): Promise<Response> {
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
  const embeddedSignupEnabled = whatsappEmbeddedSignupEnabled((name) =>
    Deno.env.get(name),
  );

  const businessTokenValidationClaim = embeddedSignupEnabled
    ? await client.rpc("claim_whatsapp_business_token_validation_jobs", {
        p_limit: 2,
      })
    : { data: [], error: null };
  if (businessTokenValidationClaim.error) {
    console.error("WhatsApp business token validation claim failed", {
      code: "WHATSAPP_TOKEN_VALIDATION_CLAIM_FAILED",
    });
    return jsonResponse(
      request,
      { error: "WHATSAPP_TOKEN_VALIDATION_CLAIM_FAILED" },
      500,
    );
  }
  const businessTokenValidationJobs = (businessTokenValidationClaim.data ??
    []) as BusinessTokenValidationJob[];
  let tokenValidationsCompleted = 0;
  let tokenValidationsInvalid = 0;
  let tokenValidationsRetrying = 0;
  let tokenValidationsFailed = 0;
  for (const job of businessTokenValidationJobs) {
    try {
      const disposition = await processBusinessTokenValidation(client, job);
      if (disposition === "invalid") tokenValidationsInvalid += 1;
      else if (disposition === "rescheduled") tokenValidationsCompleted += 1;
    } catch (error) {
      try {
        const disposition = await failBusinessTokenValidation(
          client,
          job,
          error,
        );
        if (disposition === "retrying" || disposition === "stale") {
          tokenValidationsRetrying += 1;
        } else {
          tokenValidationsFailed += 1;
        }
      } catch {
        tokenValidationsFailed += 1;
        console.error("Business token validation failure was not persisted", {
          accountId: job.account_id,
          code: "WHATSAPP_TOKEN_VALIDATION_FAILURE_PERSIST_FAILED",
        });
      }
      console.error("WhatsApp business token validation failed", {
        accountId: job.account_id,
        code: safeEmbeddedSignupErrorCode(error),
      });
    }
  }

  const validationClaim = embeddedSignupEnabled
    ? await client.rpc("claim_whatsapp_embedded_signup_validations", {
        p_limit: 1,
        p_attempt_id: null,
      })
    : { data: [], error: null };
  if (validationClaim.error) {
    console.error("WhatsApp Embedded Signup validation claim failed", {
      code: "WHATSAPP_EMBEDDED_VALIDATION_CLAIM_FAILED",
    });
    return jsonResponse(
      request,
      { error: "WHATSAPP_EMBEDDED_VALIDATION_CLAIM_FAILED" },
      500,
    );
  }
  const validationJobs = (validationClaim.data ??
    []) as EmbeddedSignupValidationJob[];
  let validationsCompleted = 0;
  let validationsFailed = 0;
  let validationsRetrying = 0;
  for (const job of validationJobs) {
    try {
      const disposition = await processEmbeddedSignupValidation(client, job);
      if (disposition === "completed") validationsCompleted += 1;
      else validationsFailed += 1;
    } catch (error) {
      try {
        const disposition = await persistValidationFailure(client, job, error);
        if (disposition === "retrying" || disposition === "stale") {
          validationsRetrying += 1;
        } else {
          validationsFailed += 1;
        }
      } catch {
        validationsFailed += 1;
        console.error("Embedded Signup validation failure was not persisted", {
          attemptId: job.attempt_id,
          code: "WHATSAPP_EMBEDDED_VALIDATION_FAILURE_PERSIST_FAILED",
        });
      }
      console.error("WhatsApp Embedded Signup validation failed", {
        attemptId: job.attempt_id,
        code: safeEmbeddedSignupErrorCode(error),
      });
    }
  }

  const onboardingClaim = embeddedSignupEnabled
    ? await client.rpc("claim_whatsapp_onboarding_jobs", { p_limit: 1 })
    : { data: [], error: null };
  if (onboardingClaim.error) {
    console.error("WhatsApp onboarding outbox claim failed", {
      code: "WHATSAPP_ONBOARDING_QUEUE_CLAIM_FAILED",
    });
    return jsonResponse(
      request,
      { error: "WHATSAPP_ONBOARDING_QUEUE_CLAIM_FAILED" },
      500,
    );
  }
  const onboardingJobs = (onboardingClaim.data ?? []) as OnboardingJob[];
  let onboardingCompleted = 0;
  let onboardingFailed = 0;
  for (const job of onboardingJobs) {
    try {
      await processOnboardingJob(client, job);
      onboardingCompleted += 1;
    } catch (error) {
      let locallyFinalized = false;
      try {
        locallyFinalized =
          error instanceof MetaEmbeddedSignupError
            ? await finalizeLocalOffboardingForInvalidCredential(
                client,
                job,
                error,
              )
            : false;
      } catch {
        // Keep the lease intact. Stale-lease recovery will safely reconcile
        // the WABA-wide unsubscribe before any future mutation.
        onboardingFailed += 1;
        console.error("Local WhatsApp offboarding could not be persisted", {
          jobId: job.id,
          code: "WHATSAPP_LOCAL_OFFBOARDING_FINALIZATION_FAILED",
        });
        continue;
      }
      if (locallyFinalized) {
        onboardingCompleted += 1;
        console.warn(
          "WhatsApp credential invalid; local offboarding finalized",
          {
            jobId: job.id,
            code: safeEmbeddedSignupErrorCode(error),
          },
        );
      } else {
        onboardingFailed += 1;
        await persistOnboardingJobFailure(client, job, error);
        console.error("WhatsApp onboarding job failed", {
          jobId: job.id,
          operation: job.operation,
          code: safeEmbeddedSignupErrorCode(error),
        });
      }
    }
  }

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
  if (
    events.length > 0 ||
    onboardingJobs.length > 0 ||
    validationJobs.length > 0 ||
    businessTokenValidationJobs.length > 0
  ) {
    await scheduleAnotherRun(expectedInternalSecret);
  }

  return jsonResponse(request, {
    processed: true,
    claimed:
      events.length +
      onboardingJobs.length +
      validationJobs.length +
      businessTokenValidationJobs.length,
    completed:
      completed +
      onboardingCompleted +
      validationsCompleted +
      tokenValidationsCompleted,
    yielded,
    failed:
      failed +
      onboardingFailed +
      validationsFailed +
      tokenValidationsFailed +
      tokenValidationsInvalid,
    processedItems,
    embeddedSignupValidations: {
      claimed: validationJobs.length,
      completed: validationsCompleted,
      retrying: validationsRetrying,
      failed: validationsFailed,
    },
    businessTokenValidations: {
      claimed: businessTokenValidationJobs.length,
      completed: tokenValidationsCompleted,
      invalid: tokenValidationsInvalid,
      retrying: tokenValidationsRetrying,
      failed: tokenValidationsFailed,
    },
    onboarding: {
      claimed: onboardingJobs.length,
      completed: onboardingCompleted,
      failed: onboardingFailed,
    },
    coexistence: {
      claimed: events.length,
      completed,
      yielded,
      failed,
      processedItems,
    },
  });
}

if (import.meta.main) {
  Deno.serve((request) => handleWhatsAppCoexistenceProcessorRequest(request));
}
