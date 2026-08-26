import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

export type WhatsAppGraphPurpose =
  | "send"
  | "media"
  | "management"
  | "onboarding"
  | "unsubscribe"
  | "token_validation";

export type WhatsAppCredentialMode = "coexistence" | "legacy";

export interface WhatsAppAccountCredentials {
  credentialMode: WhatsAppCredentialMode;
  accountId: string | null;
  wabaId: string;
  phoneNumberId: string;
  businessAccessToken: string;
  tokenGeneration: number | null;
  coexistenceStatus: string | null;
  onboardingStatus: string | null;
  appSubscriptionStatus: string | null;
  businessTokenStatus: string | null;
  businessTokenValidationStatus: string | null;
  sendingPaused: boolean;
  apiVersion: string;
}

interface CredentialRpcRow {
  credential_mode: unknown;
  account_id: unknown;
  waba_id: unknown;
  phone_number_id: unknown;
  business_access_token: unknown;
  token_generation: unknown;
  coexistence_status: unknown;
  onboarding_status: unknown;
  app_subscription_status: unknown;
  business_token_status: unknown;
  business_token_validation_status: unknown;
  sending_paused: unknown;
}

export class WhatsAppCredentialResolutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, options: { retryable?: boolean } = {}) {
    super(code);
    this.name = "WhatsAppCredentialResolutionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

const TERMINAL_CREDENTIAL_RPC_CODES = new Set([
  "WHATSAPP_CREDENTIAL_PURPOSE_INVALID",
  "WHATSAPP_CREDENTIAL_SELECTOR_INVALID",
  "WHATSAPP_CREDENTIAL_CONVERSATION_NOT_FOUND",
  "WHATSAPP_CREDENTIAL_CONVERSATION_UNBOUND",
  "WHATSAPP_CREDENTIAL_ACCOUNT_MISMATCH",
  "WHATSAPP_CREDENTIAL_ACCOUNT_REQUIRED",
  "WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_NOT_FOUND",
  "WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_AMBIGUOUS",
  "WHATSAPP_BUSINESS_CREDENTIAL_GENERATION_STALE",
  "WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_BLOCKED",
  "WHATSAPP_BUSINESS_CREDENTIAL_UNAVAILABLE",
  "WHATSAPP_BUSINESS_CREDENTIAL_CORRUPT",
  "WHATSAPP_LEGACY_CREDENTIALS_DISABLED",
  "WHATSAPP_SENDING_PAUSED",
]);

function safeCredentialRpcFailure(message: string): {
  code: string;
  retryable: boolean;
} {
  const code = message.match(/\bWHATSAPP_[A-Z0-9_]{3,100}\b/)?.[0];
  if (!code) {
    return { code: "WHATSAPP_CREDENTIAL_RESOLUTION_FAILED", retryable: true };
  }
  return { code, retryable: !TERMINAL_CREDENTIAL_RPC_CODES.has(code) };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_ID_PATTERN = /^[0-9]{5,64}$/;
const API_VERSION_PATTERN = /^v[1-9][0-9]{0,2}\.0$/;
const COEXISTENCE_STATUSES = new Set([
  "pending",
  "onboarding",
  "active",
  "paused",
  "disconnected",
  "error",
]);
const ONBOARDING_STATUSES = new Set([
  "not_started",
  "provisioning",
  "completed",
  "failed",
  "offboarding",
  "offboarded",
]);
const APP_SUBSCRIPTION_STATUSES = new Set([
  "not_subscribed",
  "pending",
  "subscribed",
  "failed",
  "unsubscribing",
  "unsubscribed",
  "unknown",
]);
const BUSINESS_TOKEN_STATUSES = new Set([
  "missing",
  "active",
  "unknown",
  "invalid",
  "expired",
  "revoked",
]);
const TOKEN_VALIDATION_STATUSES = new Set([
  "missing",
  "valid",
  "unknown",
  "invalid",
  "expired",
  // Kept as a recognized fail-closed value for compatibility with the
  // lifecycle contract. The current schema represents this condition with a
  // separate attention_required flag and will normally return "unknown".
  "attention_required",
]);

function runtimeEnvironment(name: string): string | undefined {
  if (typeof Deno !== "undefined") return Deno.env.get(name);
  const nodeProcess = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return nodeProcess?.env?.[name];
}

function requiredEnvironment(name: string): string {
  const value = runtimeEnvironment(name)?.trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new WhatsAppCredentialResolutionError(
      `WHATSAPP_CREDENTIAL_CONFIGURATION_MISSING:${name}`,
    );
  }
  return value;
}

function validOptionalUuid(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  const clean = value.trim();
  if (!UUID_PATTERN.test(clean)) {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_CREDENTIAL_SELECTOR_INVALID",
    );
  }
  return clean;
}

function validOptionalMetaId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  const clean = value.trim();
  if (!META_ID_PATTERN.test(clean)) {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_CREDENTIAL_SELECTOR_INVALID",
    );
  }
  return clean;
}

function firstRow(value: unknown): CredentialRpcRow | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return row as CredentialRpcRow;
}

function safeCredential(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 16_384 &&
    !/[\r\n]/.test(value)
    ? value
    : null;
}

function safeStatus(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(value)
    ? value
    : null;
}

export function isWhatsAppCredentialResolutionError(
  error: unknown,
): error is WhatsAppCredentialResolutionError {
  return error instanceof WhatsAppCredentialResolutionError;
}

function assertExpectedIdentity(input: {
  accountId: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  expectedTokenGeneration: number | null;
  resolvedAccountId: string;
  resolvedWabaId: string;
  resolvedPhoneNumberId: string;
  resolvedTokenGeneration: number;
}): void {
  if (
    (input.accountId !== null && input.accountId !== input.resolvedAccountId) ||
    (input.wabaId !== null && input.wabaId !== input.resolvedWabaId) ||
    (input.phoneNumberId !== null &&
      input.phoneNumberId !== input.resolvedPhoneNumberId) ||
    (input.expectedTokenGeneration !== null &&
      input.expectedTokenGeneration !== input.resolvedTokenGeneration)
  ) {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_CREDENTIAL_IDENTITY_MISMATCH",
    );
  }
}

function assertCoexistencePurposeState(
  purpose: WhatsAppGraphPurpose,
  row: {
    coexistenceStatus: string;
    onboardingStatus: string;
    appSubscriptionStatus: string;
    businessTokenStatus: string;
    validationStatus: string;
    sendingPaused: boolean;
  },
): void {
  if (purpose === "token_validation") {
    if (
      row.onboardingStatus === "offboarded" ||
      row.businessTokenStatus === "missing" ||
      row.businessTokenStatus === "revoked"
    ) {
      throw new WhatsAppCredentialResolutionError(
        "WHATSAPP_ACCOUNT_DISCONNECTED",
      );
    }
    return;
  }

  if (purpose === "unsubscribe") {
    if (
      row.onboardingStatus !== "offboarding" ||
      row.coexistenceStatus !== "paused" ||
      !["active", "unknown", "invalid", "expired"].includes(
        row.businessTokenStatus,
      )
    ) {
      throw new WhatsAppCredentialResolutionError(
        "WHATSAPP_ACCOUNT_NOT_READY_FOR_OPERATION",
      );
    }
    return;
  }

  if (row.businessTokenStatus !== "active") {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_BUSINESS_TOKEN_UNAVAILABLE",
    );
  }

  if (row.validationStatus !== "valid") {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_BUSINESS_TOKEN_NOT_VALIDATED",
    );
  }

  if (purpose === "onboarding") {
    if (
      !["provisioning", "completed"].includes(row.onboardingStatus) ||
      !["onboarding", "active", "paused"].includes(row.coexistenceStatus) ||
      !["pending", "subscribed"].includes(row.appSubscriptionStatus)
    ) {
      throw new WhatsAppCredentialResolutionError(
        "WHATSAPP_ACCOUNT_NOT_READY_FOR_OPERATION",
      );
    }
    return;
  }

  if (purpose === "media") {
    if (
      !["provisioning", "completed"].includes(row.onboardingStatus) ||
      !["onboarding", "active", "paused"].includes(row.coexistenceStatus) ||
      !["pending", "subscribed"].includes(row.appSubscriptionStatus)
    ) {
      throw new WhatsAppCredentialResolutionError(
        "WHATSAPP_ACCOUNT_NOT_READY_FOR_OPERATION",
      );
    }
    return;
  }

  if (
    row.onboardingStatus !== "completed" ||
    !["active", "paused"].includes(row.coexistenceStatus) ||
    row.appSubscriptionStatus !== "subscribed"
  ) {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_ACCOUNT_NOT_READY_FOR_OPERATION",
    );
  }

  if (
    purpose === "send" &&
    (row.coexistenceStatus !== "active" || row.sendingPaused)
  ) {
    throw new WhatsAppCredentialResolutionError("WHATSAPP_SENDING_PAUSED");
  }
}

function apiVersion(): string {
  const value = requiredEnvironment("WHATSAPP_GRAPH_API_VERSION");
  if (!API_VERSION_PATTERN.test(value)) {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_CREDENTIAL_CONFIGURATION_INVALID:WHATSAPP_GRAPH_API_VERSION",
    );
  }
  return value;
}

export async function resolveWhatsAppAccountCredentials(input: {
  client: SupabaseClient;
  purpose: WhatsAppGraphPurpose;
  coexistenceAccountId?: string | null;
  wabaId?: string | null;
  phoneNumberId?: string | null;
  conversationId?: string | null;
  expectedTokenGeneration?: number | null;
}): Promise<WhatsAppAccountCredentials> {
  const accountId = validOptionalUuid(input.coexistenceAccountId);
  const wabaId = validOptionalMetaId(input.wabaId);
  const phoneNumberId = validOptionalMetaId(input.phoneNumberId);
  const conversationId = validOptionalUuid(input.conversationId);
  const expectedTokenGeneration = input.expectedTokenGeneration ?? null;
  if (
    expectedTokenGeneration !== null &&
    (!Number.isSafeInteger(expectedTokenGeneration) ||
      expectedTokenGeneration <= 0)
  ) {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_CREDENTIAL_SELECTOR_INVALID",
    );
  }

  const result = await input.client.rpc(
    "resolve_whatsapp_account_credentials",
    {
      p_purpose: input.purpose,
      p_account_id: accountId,
      p_waba_id: wabaId,
      p_phone_number_id: phoneNumberId,
      p_conversation_id: conversationId,
      p_expected_token_generation: expectedTokenGeneration,
    },
  );
  if (result.error) {
    const failure = safeCredentialRpcFailure(result.error.message);
    throw new WhatsAppCredentialResolutionError(failure.code, {
      retryable: failure.retryable,
    });
  }
  const row = firstRow(result.data);
  if (!row) {
    // Management/onboarding can intentionally return no credential after
    // atomically scheduling a fresh debug_token job. The current operation
    // remains blocked, but a leased worker must retry after that validation.
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_CREDENTIAL_VALIDATION_PENDING",
      { retryable: true },
    );
  }
  if (typeof row.sending_paused !== "boolean") {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_CREDENTIAL_RESPONSE_INVALID",
      { retryable: true },
    );
  }

  if (row.credential_mode === "legacy") {
    if (
      accountId !== null ||
      expectedTokenGeneration !== null ||
      row.account_id !== null ||
      row.business_access_token !== null ||
      row.token_generation !== null
    ) {
      throw new WhatsAppCredentialResolutionError(
        "WHATSAPP_CREDENTIAL_RESPONSE_INVALID",
      );
    }
    if (
      input.purpose === "onboarding" ||
      input.purpose === "unsubscribe" ||
      input.purpose === "token_validation"
    ) {
      throw new WhatsAppCredentialResolutionError(
        "WHATSAPP_LEGACY_MODE_NOT_ALLOWED",
      );
    }
    if (input.purpose === "send" && row.sending_paused) {
      throw new WhatsAppCredentialResolutionError("WHATSAPP_SENDING_PAUSED");
    }

    // These secrets are intentionally read only after SQL explicitly confirms
    // that this installation is still in legacy mode. RPC errors, empty rows or
    // malformed Coexistence rows can therefore never fall through to env.
    const legacyWabaId = requiredEnvironment("WHATSAPP_BUSINESS_ACCOUNT_ID");
    const legacyPhoneNumberId = requiredEnvironment("WHATSAPP_PHONE_NUMBER_ID");
    const legacyToken = requiredEnvironment("WHATSAPP_ACCESS_TOKEN");
    if (
      !META_ID_PATTERN.test(legacyWabaId) ||
      !META_ID_PATTERN.test(legacyPhoneNumberId)
    ) {
      throw new WhatsAppCredentialResolutionError(
        "WHATSAPP_LEGACY_CONFIGURATION_INVALID",
      );
    }
    if (
      (wabaId !== null && wabaId !== legacyWabaId) ||
      (phoneNumberId !== null && phoneNumberId !== legacyPhoneNumberId)
    ) {
      throw new WhatsAppCredentialResolutionError(
        "WHATSAPP_CREDENTIAL_IDENTITY_MISMATCH",
      );
    }
    return {
      credentialMode: "legacy",
      accountId: null,
      wabaId: legacyWabaId,
      phoneNumberId: legacyPhoneNumberId,
      businessAccessToken: legacyToken,
      tokenGeneration: null,
      coexistenceStatus: null,
      onboardingStatus: null,
      appSubscriptionStatus: null,
      businessTokenStatus: null,
      businessTokenValidationStatus: null,
      sendingPaused: row.sending_paused,
      apiVersion: apiVersion(),
    };
  }

  if (row.credential_mode !== "coexistence") {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_CREDENTIAL_RESPONSE_INVALID",
    );
  }
  const resolvedAccountId =
    typeof row.account_id === "string" && UUID_PATTERN.test(row.account_id)
      ? row.account_id
      : null;
  const resolvedWabaId =
    typeof row.waba_id === "string" && META_ID_PATTERN.test(row.waba_id)
      ? row.waba_id
      : null;
  const resolvedPhoneNumberId =
    typeof row.phone_number_id === "string" &&
    META_ID_PATTERN.test(row.phone_number_id)
      ? row.phone_number_id
      : null;
  const resolvedToken = safeCredential(row.business_access_token);
  const resolvedTokenGeneration =
    typeof row.token_generation === "number" &&
    Number.isSafeInteger(row.token_generation) &&
    row.token_generation > 0
      ? row.token_generation
      : null;
  const coexistenceStatus = safeStatus(row.coexistence_status);
  const onboardingStatus = safeStatus(row.onboarding_status);
  const appSubscriptionStatus = safeStatus(row.app_subscription_status);
  const businessTokenStatus = safeStatus(row.business_token_status);
  const validationStatus = safeStatus(row.business_token_validation_status);
  if (
    !resolvedAccountId ||
    !resolvedWabaId ||
    !resolvedPhoneNumberId ||
    !resolvedToken ||
    !resolvedTokenGeneration ||
    !coexistenceStatus ||
    !onboardingStatus ||
    !appSubscriptionStatus ||
    !businessTokenStatus ||
    !validationStatus ||
    !COEXISTENCE_STATUSES.has(coexistenceStatus) ||
    !ONBOARDING_STATUSES.has(onboardingStatus) ||
    !APP_SUBSCRIPTION_STATUSES.has(appSubscriptionStatus) ||
    !BUSINESS_TOKEN_STATUSES.has(businessTokenStatus) ||
    !TOKEN_VALIDATION_STATUSES.has(validationStatus)
  ) {
    throw new WhatsAppCredentialResolutionError(
      "WHATSAPP_CREDENTIAL_RESPONSE_INVALID",
    );
  }

  assertExpectedIdentity({
    accountId,
    wabaId,
    phoneNumberId,
    expectedTokenGeneration,
    resolvedAccountId,
    resolvedWabaId,
    resolvedPhoneNumberId,
    resolvedTokenGeneration,
  });
  assertCoexistencePurposeState(input.purpose, {
    coexistenceStatus,
    onboardingStatus,
    appSubscriptionStatus,
    businessTokenStatus,
    validationStatus,
    sendingPaused: row.sending_paused,
  });

  return {
    credentialMode: "coexistence",
    accountId: resolvedAccountId,
    wabaId: resolvedWabaId,
    phoneNumberId: resolvedPhoneNumberId,
    businessAccessToken: resolvedToken,
    tokenGeneration: resolvedTokenGeneration,
    coexistenceStatus,
    onboardingStatus,
    appSubscriptionStatus,
    businessTokenStatus,
    businessTokenValidationStatus: validationStatus,
    sendingPaused: row.sending_paused,
    apiVersion: apiVersion(),
  };
}
