import {
  isRequestOriginAllowed,
  jsonResponse,
  optionsResponse,
} from "../_shared/http.ts";
import {
  authorizeUser,
  createServiceClient,
  getServiceKey,
} from "../_shared/supabase.ts";
import {
  assertBusinessTokenAuthorization,
  assertBusinessTokenLifetime,
  type BusinessTokenMetadata,
  classifyEmbeddedSignupCompletionFailure,
  type EmbeddedSignupConfiguration,
  embeddedSignupConfiguration,
  exchangeEmbeddedSignupCode,
  inspectBusinessToken,
  MetaEmbeddedSignupError,
  publicEmbeddedSignupConfiguration,
  REQUIRED_WHATSAPP_SCOPES,
  safeEmbeddedSignupErrorCode,
  validateWhatsAppAssets,
  whatsappEmbeddedSignupEnabled,
} from "../_shared/whatsapp-embedded-signup.ts";
import {
  parseSafetyBoolean,
  whatsappAutomationsEnabled,
} from "../_shared/whatsapp.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

const CLIENT_SCOPE = "gisela-lentz-wp";
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1_000;
const MAXIMUM_REQUEST_BYTES = 16 * 1_024;
export const DEFAULT_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H = 10;
export const MINIMUM_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H = 5;
export const MAXIMUM_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H = 50;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_ID_PATTERN = /^[0-9]{5,64}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const MAXIMUM_ASSET_IDS = 100;

type HistoryDecision = "accepted" | "declined";
type JsonRecord = Record<string, unknown>;

export function embeddedSignupMaxAttempts24h(
  getEnvironment: (name: string) => string | undefined = (name) =>
    Deno.env.get(name),
): number {
  const raw = getEnvironment(
    "WHATSAPP_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H",
  )?.trim();
  if (!raw || !/^-?(?:0|[1-9][0-9]{0,9})$/.test(raw)) {
    return DEFAULT_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H;
  }
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured)) {
    return DEFAULT_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H;
  }
  return Math.max(
    MINIMUM_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H,
    Math.min(MAXIMUM_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H, configured),
  );
}

interface ClaimedCode {
  attempt_id: string;
  waba_id: string | null;
  exchange_deadline_at: string;
}

interface ClaimedValidation {
  attempt_id: string;
  initiated_by: string;
  validation_lease_token: string;
  business_access_token: string;
  submitted_business_portfolio_id: string | null;
  submitted_waba_id: string;
  submitted_phone_number_id: string | null;
  history_sharing_decision: HistoryDecision;
  validation_deadline_at: string;
  validation_attempts: number;
}

interface SubmittedSessionCandidate {
  event: string | null;
  version: string | number | null;
  wabaId: string;
  businessPortfolioId: string | null;
  phoneNumberId: string | null;
  assetIds: JsonRecord;
}

class EmbeddedSignupApiError extends Error {
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "EmbeddedSignupApiError";
    this.status = status;
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function firstRow<T>(value: unknown): T | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === null || candidate === undefined
    ? null
    : (candidate as T);
}

function optionalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function earliestTimestamp(
  first: string | null,
  second: string | null,
): string | null {
  if (!first) return second;
  if (!second) return first;
  return Date.parse(first) <= Date.parse(second) ? first : second;
}

function postgresErrorCode(
  error: { message?: string } | null,
  fallback: string,
): string {
  const match = error?.message?.match(/WHATSAPP_[A-Z0-9_]{3,100}/);
  return match?.[0] ?? fallback;
}

function requiredString(
  body: JsonRecord,
  key: string,
  pattern: RegExp,
  maximum = 512,
): string {
  const value = body[key];
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !pattern.test(value)
  ) {
    throw new EmbeddedSignupApiError(`INVALID_${key.toUpperCase()}`);
  }
  return value;
}

function optionalMetaId(body: JsonRecord, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !META_ID_PATTERN.test(value)) {
    throw new EmbeddedSignupApiError(`INVALID_${key.toUpperCase()}`);
  }
  return value;
}

function embeddedAssetManifest(body: JsonRecord): JsonRecord {
  const input = record(body.assetIds);
  if (!input) throw new EmbeddedSignupApiError("INVALID_ASSET_IDS");
  const mapping = {
    adAccountIds: "ad_account_ids",
    pageIds: "page_ids",
    datasetIds: "dataset_ids",
    catalogIds: "catalog_ids",
    instagramAccountIds: "instagram_account_ids",
    wabaIds: "waba_ids",
  } as const;
  const output: JsonRecord = {};
  let totalAssetIds = 0;
  for (const [inputKey, outputKey] of Object.entries(mapping)) {
    const values = input[inputKey];
    if (
      !Array.isArray(values) ||
      values.length > MAXIMUM_ASSET_IDS ||
      values.some(
        (value) => typeof value !== "string" || !META_ID_PATTERN.test(value),
      )
    ) {
      throw new EmbeddedSignupApiError("INVALID_ASSET_IDS");
    }
    const canonicalValues = [...new Set(values as string[])].sort();
    totalAssetIds += canonicalValues.length;
    if (totalAssetIds > MAXIMUM_ASSET_IDS) {
      throw new EmbeddedSignupApiError("INVALID_ASSET_IDS");
    }
    output[outputKey] = canonicalValues;
  }
  return output;
}

function optionalSessionEvent(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value)) {
    throw new EmbeddedSignupApiError("INVALID_SESSION_EVENT_METADATA");
  }
  return value;
}

function optionalSessionVersion(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 999) ||
    (typeof value === "string" && /^[0-9]{1,3}$/.test(value))
  ) {
    return value;
  }
  throw new EmbeddedSignupApiError("INVALID_SESSION_VERSION_METADATA");
}

function submittedSessionCandidate(
  body: JsonRecord,
): SubmittedSessionCandidate {
  if (body.type !== "WA_EMBEDDED_SIGNUP") {
    throw new EmbeddedSignupApiError("UNEXPECTED_EMBEDDED_SIGNUP_TYPE");
  }
  return {
    event: optionalSessionEvent(body.event),
    version: optionalSessionVersion(body.version),
    wabaId: requiredString(body, "wabaId", META_ID_PATTERN, 64),
    businessPortfolioId: optionalMetaId(body, "businessPortfolioId"),
    phoneNumberId: optionalMetaId(body, "phoneNumberId"),
    assetIds: embeddedAssetManifest(body),
  };
}

function historyDecision(body: JsonRecord): HistoryDecision {
  const value = body.historyDecision;
  if (value !== "accepted" && value !== "declined") {
    throw new EmbeddedSignupApiError("INVALID_HISTORY_DECISION");
  }
  return value;
}

function authorizationCode(body: JsonRecord): string {
  const value = body.code;
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4_096 ||
    /[\r\n]/.test(value)
  ) {
    throw new EmbeddedSignupApiError("INVALID_CODE");
  }
  return value;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function randomBase64Url(bytes = 32): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of random) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function readBody(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAXIMUM_REQUEST_BYTES) {
    throw new EmbeddedSignupApiError("PAYLOAD_TOO_LARGE", 413);
  }
  const raw = await request.text();
  if (
    !raw ||
    new TextEncoder().encode(raw).byteLength > MAXIMUM_REQUEST_BYTES
  ) {
    throw new EmbeddedSignupApiError("INVALID_BODY", 400);
  }
  try {
    const parsed = record(JSON.parse(raw));
    if (!parsed) throw new Error("not an object");
    return parsed;
  } catch {
    throw new EmbeddedSignupApiError("INVALID_BODY", 400);
  }
}

function signupConfig(): EmbeddedSignupConfiguration {
  return embeddedSignupConfiguration((name) => Deno.env.get(name));
}

function assertPostExchangeTokenMetadata(input: {
  metadata: BusinessTokenMetadata;
  config: EmbeddedSignupConfiguration;
  expectedWabaId: string | null;
}): void {
  const { metadata } = input;
  if (!metadata.isValid || metadata.appId !== input.config.appId) {
    throw new MetaEmbeddedSignupError("BUSINESS_TOKEN_INVALID", {
      status: 422,
      credentialInvalid: true,
    });
  }
  for (const scope of REQUIRED_WHATSAPP_SCOPES) {
    if (!metadata.scopes.includes(scope)) {
      throw new MetaEmbeddedSignupError("BUSINESS_TOKEN_SCOPE_MISSING", {
        status: 422,
      });
    }
    const granular = metadata.granularScopes.find(
      (candidate) => candidate.scope === scope,
    );
    if (!granular || granular.targetIds.length === 0) {
      throw new MetaEmbeddedSignupError("BUSINESS_TOKEN_TARGET_MISSING", {
        status: 422,
      });
    }
  }
  if (input.expectedWabaId !== null) {
    assertBusinessTokenAuthorization({
      metadata,
      expectedAppId: input.config.appId,
      expectedWabaId: input.expectedWabaId,
    });
  }
  assertBusinessTokenLifetime(metadata, 15 * 60 * 1_000);
}

async function recordPostExchangeValidation(input: {
  client: SupabaseClient;
  attemptId: string;
  metadata: BusinessTokenMetadata;
  errorCode: string | null;
}): Promise<void> {
  const result = await input.client.rpc(
    "record_whatsapp_embedded_signup_post_exchange_validation",
    {
      p_attempt_id: input.attemptId,
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
    throw new EmbeddedSignupApiError(
      postgresErrorCode(
        result.error,
        "WHATSAPP_EMBEDDED_SIGNUP_POST_EXCHANGE_VALIDATION_FAILED",
      ),
      500,
    );
  }
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
    throw new EmbeddedSignupApiError(
      postgresErrorCode(
        result.error,
        "WHATSAPP_EMBEDDED_SIGNUP_PRE_COMPLETION_VALIDATION_FAILED",
      ),
      500,
    );
  }
}

async function recordSessionCandidate(input: {
  client: SupabaseClient;
  userId: string;
  candidate: SubmittedSessionCandidate;
  attemptId: string;
  stateHash: string;
  nonceHash: string;
  decision: HistoryDecision;
  callbackReceivedAt: string;
}): Promise<void> {
  const { wabaId, businessPortfolioId, phoneNumberId, assetIds } =
    input.candidate;
  const eventHash = await sha256Hex(
    JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: input.candidate.event,
      version: input.candidate.version,
      wabaId,
      businessPortfolioId,
      phoneNumberId,
      assetIds,
      historyDecision: input.decision,
    }),
  );
  const result = await input.client.rpc(
    "record_whatsapp_embedded_signup_session",
    {
      p_attempt_id: input.attemptId,
      p_admin_user_id: input.userId,
      p_state_hash: input.stateHash,
      p_nonce_hash: input.nonceHash,
      p_sdk_event_hash: eventHash,
      p_callback_received_at: input.callbackReceivedAt,
      p_business_portfolio_id: businessPortfolioId,
      p_waba_id: wabaId,
      p_phone_number_id: phoneNumberId,
      p_asset_ids: assetIds,
      p_history_sharing_decision: input.decision,
    },
  );
  if (result.error || result.data !== true) {
    throw new EmbeddedSignupApiError(
      postgresErrorCode(
        result.error,
        result.data === false
          ? "WHATSAPP_EMBEDDED_SIGNUP_ATTEMPT_EXPIRED"
          : "WHATSAPP_EMBEDDED_SIGNUP_SESSION_FAILED",
      ),
      409,
    );
  }
}

async function triggerCoexistenceProcessor(): Promise<void> {
  const baseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const secret = Deno.env.get("WHATSAPP_COEXISTENCE_INTERNAL_SECRET")?.trim();
  if (!baseUrl || !secret) return;
  const task = fetch(`${baseUrl}/functions/v1/process-whatsapp-coexistence`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getServiceKey()}`,
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: "{}",
  })
    .then((response) => {
      if (!response.ok) {
        console.error("Embedded Signup processor trigger failed", {
          status: response.status,
        });
      }
    })
    .catch(() => {
      console.error("Embedded Signup processor trigger failed", {
        code: "PROCESSOR_TRIGGER_NETWORK_ERROR",
      });
    });
  const runtime = (
    globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }
  ).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
  else await task;
}

async function failAttempt(
  client: SupabaseClient,
  attemptId: string,
  userId: string,
  error: unknown,
): Promise<void> {
  const errorCode =
    error instanceof EmbeddedSignupApiError
      ? error.message
      : safeEmbeddedSignupErrorCode(error);
  await client.rpc("fail_whatsapp_embedded_signup_attempt", {
    p_attempt_id: attemptId,
    p_admin_user_id: userId,
    p_error_code: errorCode,
  });
}

async function finalizeIfReady(input: {
  client: SupabaseClient;
  userId: string;
  attemptId: string;
  config: EmbeddedSignupConfiguration;
}): Promise<JsonRecord | null> {
  const claimResult = await input.client.rpc(
    "claim_whatsapp_embedded_signup_validations",
    { p_limit: 1, p_attempt_id: input.attemptId },
  );
  if (claimResult.error) {
    throw new EmbeddedSignupApiError(
      postgresErrorCode(
        claimResult.error,
        "WHATSAPP_EMBEDDED_SIGNUP_VALIDATION_CLAIM_FAILED",
      ),
      500,
    );
  }
  const context = firstRow<ClaimedValidation>(claimResult.data);
  if (!context) return null;
  if (
    !context?.business_access_token ||
    context.attempt_id !== input.attemptId ||
    context.initiated_by !== input.userId ||
    !UUID_PATTERN.test(context.validation_lease_token) ||
    !context.submitted_waba_id ||
    (context.history_sharing_decision !== "accepted" &&
      context.history_sharing_decision !== "declined") ||
    new Date(context.validation_deadline_at).getTime() <= Date.now()
  ) {
    const invalid = new EmbeddedSignupApiError(
      "WHATSAPP_EMBEDDED_SIGNUP_VALIDATION_CONTEXT_INVALID",
      500,
    );
    await input.client.rpc("fail_whatsapp_embedded_signup_validation", {
      p_attempt_id: input.attemptId,
      p_validation_lease_token: context.validation_lease_token,
      p_error_code: invalid.message,
      p_retryable: false,
    });
    throw invalid;
  }

  let assets: Awaited<ReturnType<typeof validateWhatsAppAssets>>;
  let preCompletionRejectionPersisted = false;
  try {
    const tokenMetadata = await inspectBusinessToken({
      businessToken: context.business_access_token,
      config: input.config,
    });
    let authorizationError: unknown = null;
    try {
      assertBusinessTokenAuthorization({
        metadata: tokenMetadata,
        expectedAppId: input.config.appId,
        expectedWabaId: context.submitted_waba_id,
      });
      assertBusinessTokenLifetime(tokenMetadata, 15 * 60 * 1_000);
    } catch (error) {
      authorizationError = error;
    }
    await recordPreCompletionValidation({
      client: input.client,
      attemptId: input.attemptId,
      validationLeaseToken: context.validation_lease_token,
      metadata: tokenMetadata,
      errorCode:
        authorizationError === null
          ? null
          : safeEmbeddedSignupErrorCode(authorizationError),
    });
    if (authorizationError !== null) {
      preCompletionRejectionPersisted = true;
      throw authorizationError;
    }
    assets = await validateWhatsAppAssets({
      businessToken: context.business_access_token,
      expectedWabaId: context.submitted_waba_id,
      expectedPhoneNumberId: context.submitted_phone_number_id,
      expectedBusinessPortfolioId: context.submitted_business_portfolio_id,
      config: input.config,
      inspectedTokenMetadata: tokenMetadata,
    });
  } catch (error) {
    // The checkpoint RPC has already made a deterministic authorization
    // rejection terminal and removed only the temporary Vault credential.
    // A second failure transition would turn the real rejection into a stale
    // lease result and hide it from the authenticated caller.
    if (preCompletionRejectionPersisted) throw error;
    const retryable =
      error instanceof MetaEmbeddedSignupError &&
      error.retryable &&
      !error.outcomeUnknown;
    const failed = await input.client.rpc(
      "fail_whatsapp_embedded_signup_validation",
      {
        p_attempt_id: input.attemptId,
        p_validation_lease_token: context.validation_lease_token,
        p_error_code: safeEmbeddedSignupErrorCode(error),
        p_retryable: retryable,
      },
    );
    if (failed.error) {
      throw new EmbeddedSignupApiError(
        "WHATSAPP_EMBEDDED_SIGNUP_VALIDATION_FAILURE_PERSIST_FAILED",
        500,
      );
    }
    if (failed.data === "retrying" || failed.data === "stale") return null;
    throw error;
  }

  const completion = await input.client.rpc(
    "complete_whatsapp_embedded_signup",
    {
      p_attempt_id: input.attemptId,
      p_admin_user_id: input.userId,
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
      p_validation_lease_token: context.validation_lease_token,
    },
  );
  if (completion.error) {
    const failure = classifyEmbeddedSignupCompletionFailure(completion.error);
    const failed = await input.client.rpc(
      "fail_whatsapp_embedded_signup_validation",
      {
        p_attempt_id: input.attemptId,
        p_validation_lease_token: context.validation_lease_token,
        p_error_code: failure.code,
        p_retryable: failure.retryable,
      },
    );
    if (failed.error) {
      throw new EmbeddedSignupApiError(
        "WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_FAILURE_PERSIST_FAILED",
        500,
      );
    }
    if (!failure.retryable) {
      throw new EmbeddedSignupApiError(failure.code, failure.status);
    }
    return null;
  }
  const row = firstRow<JsonRecord>(completion.data);
  if (!row) {
    const failed = await input.client.rpc(
      "fail_whatsapp_embedded_signup_validation",
      {
        p_attempt_id: input.attemptId,
        p_validation_lease_token: context.validation_lease_token,
        p_error_code: "WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_INVALID_RESPONSE",
        p_retryable: true,
      },
    );
    if (failed.error) {
      throw new EmbeddedSignupApiError(
        "WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_FAILURE_PERSIST_FAILED",
        500,
      );
    }
    return null;
  }
  await triggerCoexistenceProcessor();
  return {
    completed: true,
    accountId: row.account_id,
    onboardingStatus: row.onboarding_status,
    subscriptionStatus: row.subscription_status,
    contactsStatus: row.contacts_status,
    historyStatus: row.history_status,
    syncDeadlineAt: row.sync_deadline_at,
  };
}

async function actionStatus(
  client: SupabaseClient,
  userId: string,
  options: { strictForManual?: boolean } = {},
): Promise<JsonRecord> {
  const result = await client.rpc("whatsapp_embedded_signup_status", {
    p_admin_user_id: userId,
    p_client_scope: CLIENT_SCOPE,
  });
  if (result.error) {
    throw new EmbeddedSignupApiError(
      postgresErrorCode(result.error, "WHATSAPP_EMBEDDED_SIGNUP_STATUS_FAILED"),
      500,
    );
  }
  const status = record(result.data) ?? {};
  let configured = true;
  try {
    signupConfig();
  } catch {
    configured = false;
  }
  const onboarding = record(status.onboarding);
  const account = record(status.account);
  const strictForManual = options.strictForManual === true;
  const accountConnected =
    typeof account?.connected === "boolean" ? account.connected : null;
  const accountAttentionRequired =
    typeof account?.attentionRequired === "boolean"
      ? account.attentionRequired
      : null;
  const accountTokenExpired =
    typeof account?.tokenExpired === "boolean" ? account.tokenExpired : null;
  const sendingPaused =
    typeof status.sendingPaused === "boolean" ? status.sendingPaused : null;
  const pendingJobs = nonNegativeSafeInteger(status.pendingJobs);
  const ambiguousJobs = nonNegativeSafeInteger(status.ambiguousJobs);
  const accountId =
    typeof account?.accountId === "string" &&
    UUID_PATTERN.test(account.accountId)
      ? account.accountId
      : null;
  let lastWebhookAt: string | null = null;
  let lastWebhookChecked = true;
  let recentWebhookFailures: number | null = 0;
  if (accountId) {
    // The table intentionally stays private to browser roles because it holds
    // internal Meta identifiers. This ADMIN-only endpoint returns only a
    // sanitized timestamp/count, never an account row, payload or error.
    const recentWindowStart = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const [latestWebhook, failedEvents] = await Promise.all([
      client
        .from("whatsapp_coexistence_accounts")
        .select("last_webhook_at")
        .eq("id", accountId)
        .maybeSingle(),
      client
        .from("whatsapp_coexistence_events")
        .select("id", { count: "exact", head: true })
        .eq("account_id", accountId)
        .eq("status", "failed")
        .gte("failed_at", recentWindowStart),
    ]);
    if (!latestWebhook.error) {
      const value = latestWebhook.data as { last_webhook_at?: unknown } | null;
      lastWebhookAt = optionalIsoTimestamp(value?.last_webhook_at);
    } else {
      lastWebhookChecked = false;
    }
    if (!failedEvents.error) {
      recentWebhookFailures = nonNegativeSafeInteger(failedEvents.count);
      if (recentWebhookFailures === null) lastWebhookChecked = false;
    } else {
      lastWebhookChecked = false;
    }
  }
  const tokenExpiresAt = optionalIsoTimestamp(account?.tokenExpiresAt);
  const tokenDataAccessExpiresAt = optionalIsoTimestamp(
    account?.tokenDataAccessExpiresAt,
  );
  return {
    enabled: whatsappEmbeddedSignupEnabled((name) => Deno.env.get(name)),
    configured,
    onboarding: onboarding
      ? {
          attemptId: onboarding.attemptId ?? null,
          state: onboarding.status ?? "not_started",
          status: onboarding.status ?? "not_started",
          startedAt: onboarding.startedAt ?? null,
          expiresAt: onboarding.expiresAt ?? null,
          lastError: onboarding.lastError ?? null,
        }
      : null,
    account: account
      ? {
          accountId: account.accountId ?? null,
          connected: strictForManual
            ? accountConnected
            : accountConnected === true,
          onboardingStatus: account.onboardingStatus ?? "not_started",
          wabaId: account.wabaId ?? null,
          phoneNumberId: account.phoneNumberId ?? null,
          displayPhone: account.displayPhone ?? null,
          onboardedAt: account.onboardedAt ?? null,
          subscriptionStatus: account.subscriptionStatus ?? "not_started",
          contactsStatus: account.contactsStatus ?? "not_started",
          historyStatus: account.historyStatus ?? "not_started",
          historyDecision: account.historyDecision ?? "pending",
          syncDeadlineAt: account.syncDeadlineAt ?? null,
          syncAtRisk: account.syncAtRisk === true,
          tokenConfigured: account.tokenConfigured === true,
          requiresOffboarding: account.requiresOffboarding === true,
          tokenStatus: account.tokenStatus ?? "missing",
          tokenValidationStatus: account.tokenValidationStatus ?? "missing",
          tokenLastValidatedAt: account.tokenLastValidatedAt ?? null,
          tokenValidationDueAt: account.tokenValidationDueAt ?? null,
          attentionRequired: strictForManual
            ? accountAttentionRequired
            : accountAttentionRequired === true,
          attentionReason: account.attentionReason ?? null,
          lastDisconnectionReason: account.lastDisconnectionReason ?? null,
          lastDisconnectionInitiatedBy:
            account.lastDisconnectionInitiatedBy ?? null,
          tokenExpiresAt,
          tokenDataAccessExpiresAt,
          tokenEffectiveExpiresAt: earliestTimestamp(
            tokenExpiresAt,
            tokenDataAccessExpiresAt,
          ),
          tokenExpiryKnown: account.tokenExpiryKnown === true,
          tokenExpired: strictForManual
            ? accountTokenExpired
            : accountTokenExpired === true,
          lastError: account.lastError ?? null,
          offboardedAt: account.offboardedAt ?? null,
        }
      : null,
    sendingPaused: strictForManual ? sendingPaused : sendingPaused !== false,
    pendingJobs: strictForManual ? pendingJobs : (pendingJobs ?? 0),
    ambiguousJobs: strictForManual ? ambiguousJobs : (ambiguousJobs ?? 0),
    automationsEnabled: whatsappAutomationsEnabled(),
    // Expose only a boolean for the administrative status screen. The allowlist
    // and all delivery credentials remain server-side.
    testMode: parseSafetyBoolean(Deno.env.get("WHATSAPP_TEST_MODE"), true),
    lastWebhookAt,
    lastWebhookChecked,
    recentWebhookFailures: strictForManual
      ? recentWebhookFailures
      : (recentWebhookFailures ?? 0),
  };
}

function manualStatusProjection(status: JsonRecord): JsonRecord {
  const account = record(status.account);
  return {
    accountPresent: account !== null,
    connected:
      typeof account?.connected === "boolean" ? account.connected : null,
    attentionRequired:
      typeof account?.attentionRequired === "boolean"
        ? account.attentionRequired
        : null,
    tokenExpired:
      typeof account?.tokenExpired === "boolean" ? account.tokenExpired : null,
    sendingPaused:
      typeof status.sendingPaused === "boolean" ? status.sendingPaused : null,
    pendingJobs: nonNegativeSafeInteger(status.pendingJobs),
    ambiguousJobs: nonNegativeSafeInteger(status.ambiguousJobs),
    automationsEnabled:
      typeof status.automationsEnabled === "boolean"
        ? status.automationsEnabled
        : null,
    testMode: typeof status.testMode === "boolean" ? status.testMode : null,
    lastWebhookAt: optionalIsoTimestamp(status.lastWebhookAt),
    lastWebhookChecked: status.lastWebhookChecked === true,
    recentWebhookFailures: nonNegativeSafeInteger(status.recentWebhookFailures),
  };
}

async function actionManualStatus(
  client: SupabaseClient,
  userId: string,
): Promise<JsonRecord> {
  return manualStatusProjection(
    await actionStatus(client, userId, { strictForManual: true }),
  );
}

async function actionStart(
  client: SupabaseClient,
  userId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  if (!whatsappEmbeddedSignupEnabled((name) => Deno.env.get(name))) {
    throw new EmbeddedSignupApiError("WHATSAPP_EMBEDDED_SIGNUP_DISABLED", 404);
  }
  if (whatsappAutomationsEnabled()) {
    throw new EmbeddedSignupApiError(
      "WHATSAPP_AUTOMATIONS_MUST_BE_DISABLED",
      409,
    );
  }
  const decision = historyDecision(body);
  const config = signupConfig();
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const expiresAt = new Date(Date.now() + ATTEMPT_LIFETIME_MS).toISOString();
  const result = await client.rpc("create_whatsapp_embedded_signup_attempt", {
    p_admin_user_id: userId,
    p_client_scope: CLIENT_SCOPE,
    p_state_hash: await sha256Hex(state),
    p_nonce_hash: await sha256Hex(nonce),
    p_app_id: config.appId,
    p_configuration_id: config.configurationId,
    p_history_sharing_decision: decision,
    p_expires_at: expiresAt,
    p_max_attempts_24h: embeddedSignupMaxAttempts24h(),
  });
  if (result.error) {
    throw new EmbeddedSignupApiError(
      postgresErrorCode(result.error, "WHATSAPP_EMBEDDED_SIGNUP_START_FAILED"),
      409,
    );
  }
  const row = firstRow<{
    attempt_id: string | null;
    status: string | null;
    expires_at: string | null;
  }>(result.data);
  if (row?.status === "rate_limited") {
    throw new EmbeddedSignupApiError(
      "WHATSAPP_EMBEDDED_SIGNUP_RATE_LIMITED",
      409,
    );
  }
  if (row?.status !== "initiated" || !row.attempt_id || !row.expires_at) {
    throw new EmbeddedSignupApiError(
      "WHATSAPP_EMBEDDED_SIGNUP_START_FAILED",
      500,
    );
  }
  return {
    attemptId: row.attempt_id,
    state,
    nonce,
    expiresAt: row.expires_at,
    ...publicEmbeddedSignupConfiguration(config),
    sdkVersion: config.apiVersion,
  };
}

async function callbackContext(body: JsonRecord): Promise<{
  attemptId: string;
  stateHash: string;
  nonceHash: string;
  decision: HistoryDecision;
}> {
  const attemptId = requiredString(body, "attemptId", UUID_PATTERN, 36);
  const state = requiredString(body, "state", OPAQUE_PATTERN);
  const nonce = requiredString(body, "nonce", OPAQUE_PATTERN);
  return {
    attemptId,
    stateHash: await sha256Hex(state),
    nonceHash: await sha256Hex(nonce),
    decision: historyDecision(body),
  };
}

async function actionExchange(
  client: SupabaseClient,
  userId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const receivedAtMs = Date.now();
  const config = signupConfig();
  const context = await callbackContext(body);
  // Parse the untrusted browser candidate before consuming the one-shot OAuth
  // code. It remains evidence only; Graph canonicalization below is authority.
  const sessionCandidate =
    body.wabaId === undefined ? null : submittedSessionCandidate(body);
  const code = authorizationCode(body);
  const codeHash = await sha256Hex(code);
  if (sessionCandidate) {
    // Persist the idempotent browser evidence before consuming Meta's
    // one-shot code. This RPC validates the same admin/state/nonce and lets
    // every subsequent token checkpoint bind to the candidate WABA.
    await recordSessionCandidate({
      client,
      userId,
      candidate: sessionCandidate,
      ...context,
      callbackReceivedAt: new Date(receivedAtMs).toISOString(),
    });
  }
  const claim = await client.rpc("claim_whatsapp_embedded_signup_code", {
    p_attempt_id: context.attemptId,
    p_admin_user_id: userId,
    p_state_hash: context.stateHash,
    p_nonce_hash: context.nonceHash,
    p_code_hash: codeHash,
  });
  if (claim.error) {
    throw new EmbeddedSignupApiError(
      postgresErrorCode(claim.error, "WHATSAPP_EMBEDDED_SIGNUP_CODE_REJECTED"),
      409,
    );
  }
  const claimed = firstRow<ClaimedCode>(claim.data);
  if (
    !claimed?.attempt_id ||
    new Date(claimed.exchange_deadline_at).getTime() <= Date.now()
  ) {
    throw new EmbeddedSignupApiError(
      "WHATSAPP_EMBEDDED_SIGNUP_CODE_EXPIRED",
      409,
    );
  }

  let token: Awaited<ReturnType<typeof exchangeEmbeddedSignupCode>>;
  try {
    token = await exchangeEmbeddedSignupCode({
      code,
      receivedAtMs,
      config,
    });
  } catch (error) {
    await failAttempt(client, context.attemptId, userId, error);
    throw error;
  }
  const stored = await client.rpc(
    "store_whatsapp_embedded_signup_exchange_token",
    {
      p_attempt_id: context.attemptId,
      p_code_hash: codeHash,
      p_business_access_token: token.accessToken,
    },
  );
  if (stored.error || stored.data !== true) {
    throw new EmbeddedSignupApiError(
      postgresErrorCode(
        stored.error,
        "WHATSAPP_EMBEDDED_SIGNUP_TOKEN_STORE_FAILED",
      ),
      500,
    );
  }
  try {
    const metadata = await inspectBusinessToken({
      businessToken: token.accessToken,
      config,
    });
    let validationError: unknown = null;
    try {
      const claimedWabaId =
        sessionCandidate?.wabaId ??
        (typeof claimed.waba_id === "string" &&
        META_ID_PATTERN.test(claimed.waba_id)
          ? claimed.waba_id
          : null);
      assertPostExchangeTokenMetadata({
        metadata,
        config,
        expectedWabaId: claimedWabaId,
      });
    } catch (error) {
      validationError = error;
    }
    // Persist the real post-exchange debug_token result before evaluating it.
    // Invalid or insufficient credentials therefore remain auditable without
    // ever persisting the token itself outside Vault.
    await recordPostExchangeValidation({
      client,
      attemptId: context.attemptId,
      metadata,
      errorCode:
        validationError === null
          ? null
          : safeEmbeddedSignupErrorCode(validationError),
    });
    if (validationError !== null) throw validationError;
  } catch (error) {
    await failAttempt(client, context.attemptId, userId, error);
    throw error;
  }
  const completion = await finalizeIfReady({
    client,
    userId,
    attemptId: context.attemptId,
    config,
  });
  return { accepted: true, completed: completion?.completed === true };
}

async function actionFinish(
  client: SupabaseClient,
  userId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const callbackReceivedAt = new Date().toISOString();
  const config = signupConfig();
  const context = await callbackContext(body);
  await recordSessionCandidate({
    client,
    userId,
    candidate: submittedSessionCandidate(body),
    ...context,
    callbackReceivedAt,
  });
  const completion = await finalizeIfReady({
    client,
    userId,
    attemptId: context.attemptId,
    config,
  });
  return { accepted: true, completed: completion?.completed === true };
}

async function actionCancel(
  client: SupabaseClient,
  userId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const attemptId = requiredString(body, "attemptId", UUID_PATTERN, 36);
  if (
    body.reason !== "USER_CANCELLED" &&
    body.reason !== "META_CANCELLED" &&
    body.reason !== "META_ERROR"
  ) {
    throw new EmbeddedSignupApiError("INVALID_CANCELLATION_REASON");
  }
  const reason = body.reason;
  const result = await client.rpc("cancel_whatsapp_embedded_signup_attempt", {
    p_attempt_id: attemptId,
    p_admin_user_id: userId,
    p_reason: reason,
  });
  if (result.error) {
    throw new EmbeddedSignupApiError(
      postgresErrorCode(result.error, "WHATSAPP_EMBEDDED_SIGNUP_CANCEL_FAILED"),
      409,
    );
  }
  return { cancelled: result.data === true };
}

function actionDiagnostic(body: JsonRecord): JsonRecord {
  const origin = body.origin;
  const dataType = body.dataType;
  const type = body.type;
  const event = body.event;
  const version = body.version;
  const hasCurrentStep = body.hasCurrentStep;
  const hasWabaId = body.hasWabaId;
  const sourceMatchesCapturedPopup = body.sourceMatchesCapturedPopup;
  const dataKeys = body.dataKeys;
  const validEvent =
    event === null ||
    (typeof event === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(event));
  const validVersion =
    version === null ||
    (typeof version === "number" &&
      Number.isSafeInteger(version) &&
      version >= 0 &&
      version <= 999) ||
    (typeof version === "string" && /^[0-9]{1,3}$/.test(version));
  const validDataKeys =
    Array.isArray(dataKeys) &&
    dataKeys.length <= 50 &&
    dataKeys.every(
      (key) =>
        typeof key === "string" &&
        /^[a-z][a-z0-9_]{0,39}$/.test(key) &&
        !/[0-9]{5,}/.test(key),
    );
  if (
    origin !== "https://www.facebook.com" ||
    (dataType !== "string" && dataType !== "object") ||
    type !== "WA_EMBEDDED_SIGNUP" ||
    !validEvent ||
    !validVersion ||
    typeof hasCurrentStep !== "boolean" ||
    typeof hasWabaId !== "boolean" ||
    typeof sourceMatchesCapturedPopup !== "boolean" ||
    !validDataKeys
  ) {
    throw new EmbeddedSignupApiError("INVALID_SESSION_DIAGNOSTIC");
  }
  console.info("WhatsApp Embedded Signup session event", {
    origin,
    dataType,
    type,
    event,
    version,
    hasCurrentStep,
    hasWabaId,
    sourceMatchesCapturedPopup,
    dataKeys,
  });
  return { accepted: true };
}

async function actionOffboard(
  client: SupabaseClient,
  userId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const accountId = requiredString(body, "accountId", UUID_PATTERN, 36);
  const result = await client.rpc("begin_whatsapp_coexistence_offboarding", {
    p_account_id: accountId,
    p_admin_user_id: userId,
    p_client_scope: CLIENT_SCOPE,
  });
  if (result.error) {
    throw new EmbeddedSignupApiError(
      postgresErrorCode(result.error, "WHATSAPP_OFFBOARDING_START_FAILED"),
      409,
    );
  }
  if (result.data === true) await triggerCoexistenceProcessor();
  return { offboarding: result.data === true };
}

export interface EmbeddedSignupHandlerDependencies {
  createClient: () => SupabaseClient;
  authorize: (
    request: Request,
    client: SupabaseClient,
  ) => Promise<{
    user: { id: string };
    profile: { role: "ADMIN" | "OPERADOR" };
  }>;
}

const defaultHandlerDependencies: EmbeddedSignupHandlerDependencies = {
  createClient: createServiceClient,
  authorize: authorizeUser,
};

export async function handleWhatsAppEmbeddedSignupRequest(
  request: Request,
  dependencies: EmbeddedSignupHandlerDependencies = defaultHandlerDependencies,
): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }
  if (!isRequestOriginAllowed(request)) {
    return jsonResponse(request, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  }

  const client = dependencies.createClient();
  try {
    const { user, profile } = await dependencies.authorize(request, client);
    if (profile.role !== "ADMIN") {
      return jsonResponse(request, { error: "ADMIN_REQUIRED" }, 403);
    }
    const body = await readBody(request);
    const action = body.action;
    if (
      (action === "exchange" || action === "finish") &&
      !whatsappEmbeddedSignupEnabled((name) => Deno.env.get(name))
    ) {
      throw new EmbeddedSignupApiError(
        "WHATSAPP_EMBEDDED_SIGNUP_DISABLED",
        404,
      );
    }
    let response: JsonRecord;
    if (action === "status") response = await actionStatus(client, user.id);
    else if (action === "manual_status") {
      response = await actionManualStatus(client, user.id);
    } else if (action === "start") {
      response = await actionStart(client, user.id, body);
    } else if (action === "exchange") {
      response = await actionExchange(client, user.id, body);
    } else if (action === "finish") {
      response = await actionFinish(client, user.id, body);
    } else if (action === "diagnostic") {
      response = actionDiagnostic(body);
    } else if (action === "cancel") {
      response = await actionCancel(client, user.id, body);
    } else if (action === "offboard") {
      response = await actionOffboard(client, user.id, body);
    } else {
      throw new EmbeddedSignupApiError("INVALID_ACTION");
    }
    return jsonResponse(request, response);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
    }
    const status =
      error instanceof EmbeddedSignupApiError
        ? error.status
        : error instanceof MetaEmbeddedSignupError
          ? error.status
          : 500;
    const code =
      error instanceof EmbeddedSignupApiError
        ? error.message
        : safeEmbeddedSignupErrorCode(error);
    console.error("WhatsApp Embedded Signup request failed", {
      code,
      status,
    });
    return jsonResponse(request, { error: code }, status);
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleWhatsAppEmbeddedSignupRequest(request));
}
