export const FACEBOOK_JAVASCRIPT_SDK_URL =
  "https://connect.facebook.net/en_US/sdk.js";
export const FACEBOOK_JAVASCRIPT_SDK_VERSION = "v26.0";
export const WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE = "WA_EMBEDDED_SIGNUP";
export const WHATSAPP_BUSINESS_APP_FINISH_EVENT =
  "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
export const WHATSAPP_BUSINESS_APP_FEATURE_TYPE =
  "whatsapp_business_app_onboarding";
export const WHATSAPP_SESSION_INFO_VERSION = "3";
export const MAX_EMBEDDED_SIGNUP_ASSET_IDS = 100;
export const EMBEDDED_SIGNUP_TAB_ATTEMPT_MARKER =
  "whatsapp_embedded_signup_attempted_v1";
export const FACEBOOK_EMBEDDED_SIGNUP_MESSAGE_ORIGINS = [
  "https://www.facebook.com",
] as const;

const META_ASSET_ID_PATTERN = /^[0-9]{5,64}$/;
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const GRAPH_VERSION_PATTERN = /^v[0-9]+\.[0-9]+$/;

type UnknownRecord = Record<string, unknown>;

export interface EmbeddedSignupTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FacebookEmbeddedSignupLoginOptions {
  config_id: string;
  response_type: "code";
  override_default_response_type: true;
  extras: {
    setup: Record<string, never>;
    featureType: typeof WHATSAPP_BUSINESS_APP_FEATURE_TYPE;
    sessionInfoVersion: typeof WHATSAPP_SESSION_INFO_VERSION;
  };
}

export interface FacebookSdkLoginResponse {
  authResponse?: {
    code?: unknown;
  } | null;
  status?: unknown;
}

export interface FacebookJavascriptSdk {
  init(options: {
    appId: string;
    autoLogAppEvents: true;
    xfbml: true;
    version: string;
  }): void;
  login(
    callback: (response: FacebookSdkLoginResponse) => void,
    options: FacebookEmbeddedSignupLoginOptions,
  ): void;
}

export interface EmbeddedSignupAssets {
  wabaId: string;
  phoneNumberId: string | null;
  businessPortfolioId: string | null;
  adAccountIds: string[];
  pageIds: string[];
  datasetIds: string[];
  catalogIds: string[];
  instagramAccountIds: string[];
  wabaIds: string[];
}

export interface EmbeddedSignupSessionCandidate {
  kind: "session";
  type: typeof WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE;
  /** Optional browser metadata only. The backend never treats it as authority. */
  event: string | null;
  version: string | number | null;
  assets: EmbeddedSignupAssets;
}

export interface EmbeddedSignupIntermediateEvent {
  kind: "intermediate";
  type: typeof WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE;
  event: string | null;
  version: string | number | null;
  currentStepPresent: true;
}

export interface EmbeddedSignupCancelEvent {
  kind: "cancel";
  type: typeof WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE;
  event: "CANCEL";
  version: string | number | null;
  currentStep: string | null;
  errorCode: string | null;
  hasError: boolean;
}

export interface EmbeddedSignupErrorEvent {
  kind: "error";
  type: typeof WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE;
  event: "ERROR";
  version: string | number | null;
  errorCode: string | null;
}

export type EmbeddedSignupMessage =
  | EmbeddedSignupSessionCandidate
  | EmbeddedSignupIntermediateEvent
  | EmbeddedSignupCancelEvent
  | EmbeddedSignupErrorEvent;

export type EmbeddedSignupMessageRejection =
  | "UNTRUSTED_ORIGIN"
  | "INVALID_PAYLOAD"
  | "UNRELATED_MESSAGE"
  | "UNSUPPORTED_VERSION"
  | "UNEXPECTED_EVENT"
  | "INVALID_ASSETS"
  | "CONTRADICTORY_SESSION_INFO";

export type EmbeddedSignupMessageParseResult =
  | { accepted: true; message: EmbeddedSignupMessage }
  | { accepted: false; reason: EmbeddedSignupMessageRejection };

export type EmbeddedSignupMessageEffect =
  | "ignore"
  | "contradictory"
  | "session"
  | "intermediate"
  | "cancel"
  | "error";

export interface SanitizedEmbeddedSignupSessionEvent {
  origin: string;
  dataType: string;
  type: string | number | boolean | null;
  event: string | number | boolean | null;
  version: string | number | boolean | null;
  hasCurrentStep: boolean;
  hasWabaId: boolean;
  sourceMatchesCapturedPopup: boolean;
  dataKeys: string[];
}

export type HistorySharingDecision = "accepted" | "declined";

export function historySharingDecisionForNewAttempt(
  explicitlyAccepted: boolean,
): HistorySharingDecision {
  return explicitlyAccepted ? "accepted" : "declined";
}

export function embeddedSignupAccountRequiresResolution(input: {
  hasAccount: boolean;
  requiresOffboarding: boolean;
  tokenConfigured: boolean;
  onboardingStatus: string;
}): boolean {
  return (
    input.hasAccount &&
    (input.requiresOffboarding ||
      input.tokenConfigured ||
      ["provisioning", "completed", "offboarding"].includes(
        input.onboardingStatus,
      ))
  );
}

export interface EmbeddedSignupStartEligibility {
  isAdmin: boolean;
  enabled: boolean;
  configured: boolean;
  actionInProgress: boolean;
  tabAttemptLocked: boolean;
  connected: boolean;
  partialAccount: boolean;
  automationsEnabled: boolean;
  blockingAttempt: boolean;
}

/**
 * This guard is shared by the click handler and rendered button. In
 * particular, a disabled backend feature flag is checked before reserving the
 * tab tombstone, creating an attempt or loading Meta's JavaScript SDK.
 */
export function embeddedSignupStartAllowed(
  input: EmbeddedSignupStartEligibility,
): boolean {
  return (
    input.isAdmin &&
    input.enabled &&
    input.configured &&
    !input.actionInProgress &&
    !input.tabAttemptLocked &&
    !input.connected &&
    !input.partialAccount &&
    !input.automationsEnabled &&
    !input.blockingAttempt
  );
}

export function embeddedSignupSessionAcceptsCallback(input: {
  activeSessionMatches: boolean;
  closing: boolean;
  expiresAtMs: number;
  now?: number;
  sessionLifecycleState?: string;
}): boolean {
  const lifecycle =
    input.sessionLifecycleState?.trim().toLowerCase() ?? "active";
  return (
    input.activeSessionMatches &&
    !input.closing &&
    Number.isFinite(input.expiresAtMs) &&
    input.expiresAtMs > (input.now ?? Date.now()) &&
    lifecycle === "active"
  );
}

function sanitizedIsoTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 80) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

export function effectiveEmbeddedSignupTokenExpiry(input: {
  tokenExpiresAt: unknown;
  tokenDataAccessExpiresAt: unknown;
}): string {
  const tokenExpiry = sanitizedIsoTimestamp(input.tokenExpiresAt);
  const dataAccessExpiry = sanitizedIsoTimestamp(
    input.tokenDataAccessExpiresAt,
  );
  if (!tokenExpiry) return dataAccessExpiry;
  if (!dataAccessExpiry) return tokenExpiry;
  return Date.parse(tokenExpiry) <= Date.parse(dataAccessExpiry)
    ? tokenExpiry
    : dataAccessExpiry;
}

export interface EmbeddedSignupCancellableSession {
  closing: boolean;
  lifecycleState: "active" | "cancelling" | "offboarding";
}

export type EmbeddedSignupCancellationOutcome =
  | "cancelled"
  | "not_cancelled"
  | "request_failed";

/**
 * Cancellation is a one-way browser lifecycle transition. Remove the Meta
 * listener and deadline before waiting on the backend, and never make the
 * session active again when the request fails or completion wins the race.
 * The backend status is reconciled independently in every outcome.
 */
export async function cancelEmbeddedSignupSessionFailClosed(input: {
  session?: EmbeddedSignupCancellableSession;
  releaseSession: () => void | Promise<void>;
  requestCancellation: () => Promise<unknown>;
  reconcileStatus: () => void | Promise<void>;
}): Promise<{
  outcome: EmbeddedSignupCancellationOutcome;
  released: boolean;
  reconciled: boolean;
}> {
  if (input.session) {
    input.session.closing = true;
    input.session.lifecycleState = "cancelling";
  }

  let released = false;
  try {
    await input.releaseSession();
    released = true;
  } catch {
    // The irreversible lifecycle guard above remains authoritative even if a
    // browser cleanup primitive unexpectedly fails.
  }

  let outcome: EmbeddedSignupCancellationOutcome = "request_failed";
  try {
    const response = await input.requestCancellation();
    const result =
      response !== null && typeof response === "object"
        ? (response as Record<string, unknown>)
        : null;
    outcome = result?.cancelled === true ? "cancelled" : "not_cancelled";
  } catch {
    outcome = "request_failed";
  }

  let reconciled = false;
  try {
    await input.reconcileStatus();
    reconciled = true;
  } catch {
    // Reconciliation can be retried with the existing status refresh button;
    // it must never re-enable this in-memory browser session.
  }

  return { outcome, released, reconciled };
}

/**
 * Popup identity is useful telemetry but is not a protocol requirement in
 * Meta's current sample. Security comes from exact origin, the live tab-scoped
 * attempt and backend state/nonce/Graph checks.
 */
export function embeddedSignupSourceMatchesCapturedPopup<T>(
  capturedPopup: T | null,
  messageSource: T | null,
): boolean {
  return capturedPopup !== null && messageSource === capturedPopup;
}

export interface EmbeddedSignupStartConfiguration {
  attemptId: string;
  state: string;
  nonce: string;
  expiresAt: string;
  appId: string;
  configurationId: string;
  sdkVersion: string;
  sessionInfoVersion: typeof WHATSAPP_SESSION_INFO_VERSION;
  featureType: typeof WHATSAPP_BUSINESS_APP_FEATURE_TYPE;
}

export interface EmbeddedSignupHandshakeState {
  authorizationCode: string | null;
  codeReceived: boolean;
  sessionCandidate: EmbeddedSignupSessionCandidate | null;
  completionDispatched: boolean;
  completionAcknowledged: boolean;
}

export type EmbeddedSignupHandshakeAction =
  | { type: "code_received"; code: string }
  | {
      type: "session_received";
      message: EmbeddedSignupSessionCandidate;
    }
  | { type: "completion_acknowledged" };

export type EmbeddedSignupHandshakeEffect = {
  type: "complete";
  code: string;
  session: EmbeddedSignupSessionCandidate;
};

export interface EmbeddedSignupHandshakeTransition {
  state: EmbeddedSignupHandshakeState;
  effects: EmbeddedSignupHandshakeEffect[];
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function safeShortString(value: unknown, maximum = 160): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean &&
    clean.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(clean)
    ? clean
    : null;
}

function optionalAssetId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !META_ASSET_ID_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

function assetIdList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_EMBEDDED_SIGNUP_ASSET_IDS ||
    value.some(
      (candidate) =>
        typeof candidate !== "string" || !META_ASSET_ID_PATTERN.test(candidate),
    )
  ) {
    return null;
  }
  return [...new Set(value)].sort();
}

function parsedPayload(value: unknown): UnknownRecord | null {
  if (typeof value === "string") {
    if (!value.trim() || value.length > 1_000_000) return null;
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return record(value);
}

function sanitizedSessionEventName(value: unknown): string | null {
  const candidate = safeShortString(value, 100);
  return candidate && /^[A-Z][A-Z0-9_]{0,99}$/.test(candidate)
    ? candidate
    : null;
}

function sanitizedSessionVersion(value: unknown): string | number | null {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 999
  ) {
    return value;
  }
  return typeof value === "string" && /^[0-9]{1,3}$/.test(value) ? value : null;
}

/**
 * Keep production troubleshooting useful without copying payload values into
 * browser logs. In particular, nested values can contain public asset IDs and
 * must never cross this boundary; only bounded field names are retained.
 */
export function sanitizedEmbeddedSignupSessionEvent(input: {
  origin: string;
  data: unknown;
  sourceMatchesCapturedPopup?: boolean;
}): SanitizedEmbeddedSignupSessionEvent {
  const payload = parsedPayload(input.data);
  const isWhatsAppSessionEvent =
    payload?.type === WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE;
  const data = isWhatsAppSessionEvent ? record(payload.data) : null;
  const dataKeys = data
    ? Object.keys(data)
        .filter(
          (key) => /^[a-z][a-z0-9_]{0,39}$/.test(key) && !/[0-9]{5,}/.test(key),
        )
        .sort()
        .slice(0, 50)
    : [];
  return {
    origin: input.origin,
    dataType: typeof input.data,
    type: isWhatsAppSessionEvent ? WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE : null,
    event: isWhatsAppSessionEvent
      ? sanitizedSessionEventName(payload.event)
      : null,
    version: isWhatsAppSessionEvent
      ? sanitizedSessionVersion(payload.version)
      : null,
    hasCurrentStep:
      data !== null &&
      Object.prototype.hasOwnProperty.call(data, "current_step"),
    hasWabaId:
      data !== null && Object.prototype.hasOwnProperty.call(data, "waba_id"),
    sourceMatchesCapturedPopup: input.sourceMatchesCapturedPopup === true,
    dataKeys,
  };
}

/**
 * Meta's FINISH postMessage has no application state/session identifier. Keep
 * a non-sensitive, tab-scoped tombstone so a delayed popup from a cancelled
 * flow can never be combined with a later FB.login code in the same opener.
 * A retry therefore requires a fresh browser tab after closing the old popup.
 */
export function embeddedSignupTabAlreadyAttempted(
  storage: EmbeddedSignupTabStorage,
): boolean {
  try {
    return storage.getItem(EMBEDDED_SIGNUP_TAB_ATTEMPT_MARKER) !== null;
  } catch {
    return true;
  }
}

export function reserveEmbeddedSignupTabAttempt(
  storage: EmbeddedSignupTabStorage,
): boolean {
  try {
    if (storage.getItem(EMBEDDED_SIGNUP_TAB_ATTEMPT_MARKER) !== null) {
      return false;
    }
    storage.setItem(EMBEDDED_SIGNUP_TAB_ATTEMPT_MARKER, "used");
    return storage.getItem(EMBEDDED_SIGNUP_TAB_ATTEMPT_MARKER) === "used";
  } catch {
    return false;
  }
}

/**
 * Meta does not publish a finite postMessage-origin list. Keep the browser
 * integration fail-closed to the exact HTTPS origin used by the documented
 * Facebook Login dialog. A newly documented origin requires an explicit code
 * and test update; suffix/domain heuristics are deliberately forbidden.
 */
export function isTrustedFacebookMessageOrigin(origin: string): boolean {
  return FACEBOOK_EMBEDDED_SIGNUP_MESSAGE_ORIGINS.some(
    (trustedOrigin) => origin === trustedOrigin,
  );
}

export function embeddedSignupLoginOptions(
  configurationId: string,
): FacebookEmbeddedSignupLoginOptions {
  if (!META_ASSET_ID_PATTERN.test(configurationId)) {
    throw new Error("META_CONFIGURATION_ID_INVALID");
  }
  return {
    config_id: configurationId,
    response_type: "code",
    override_default_response_type: true,
    extras: {
      setup: {},
      featureType: WHATSAPP_BUSINESS_APP_FEATURE_TYPE,
      sessionInfoVersion: WHATSAPP_SESSION_INFO_VERSION,
    },
  };
}

export function facebookSdkInitialization(
  appId: string,
  version = FACEBOOK_JAVASCRIPT_SDK_VERSION,
): Parameters<FacebookJavascriptSdk["init"]>[0] {
  if (!META_ASSET_ID_PATTERN.test(appId)) {
    throw new Error("META_APP_ID_INVALID");
  }
  if (!GRAPH_VERSION_PATTERN.test(version)) {
    throw new Error("META_SDK_VERSION_INVALID");
  }
  return {
    appId,
    autoLogAppEvents: true,
    xfbml: true,
    version,
  };
}

export function parseFacebookLoginCode(response: unknown): string | null {
  const authResponse = record(record(response)?.authResponse);
  const code = authResponse?.code;
  return typeof code === "string" && code.length > 0 && code.length <= 4_096
    ? code
    : null;
}

export function parseEmbeddedSignupStartConfiguration(
  value: unknown,
  now = Date.now(),
): EmbeddedSignupStartConfiguration | null {
  const input = record(value);
  if (!input) return null;
  const attemptId = safeShortString(input.attemptId, 200);
  const state = safeShortString(input.state, 512);
  const nonce = safeShortString(input.nonce, 512);
  const expiresAt = safeShortString(input.expiresAt, 80);
  const appId = safeShortString(input.appId, 64);
  const configurationId = safeShortString(input.configurationId, 64);
  const sdkVersion =
    safeShortString(
      input.sdkVersion ?? input.graphApiVersion ?? input.apiVersion,
      20,
    ) ?? FACEBOOK_JAVASCRIPT_SDK_VERSION;
  const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;

  if (
    !attemptId ||
    !state ||
    !nonce ||
    !expiresAt ||
    !appId ||
    !configurationId ||
    !OPAQUE_VALUE_PATTERN.test(state) ||
    !OPAQUE_VALUE_PATTERN.test(nonce) ||
    !META_ASSET_ID_PATTERN.test(appId) ||
    !META_ASSET_ID_PATTERN.test(configurationId) ||
    !GRAPH_VERSION_PATTERN.test(sdkVersion) ||
    input.sessionInfoVersion !== WHATSAPP_SESSION_INFO_VERSION ||
    input.featureType !== WHATSAPP_BUSINESS_APP_FEATURE_TYPE ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now ||
    expiresAtMs > now + 30 * 60 * 1_000
  ) {
    return null;
  }

  return {
    attemptId,
    state,
    nonce,
    expiresAt: new Date(expiresAtMs).toISOString(),
    appId,
    configurationId,
    sdkVersion,
    sessionInfoVersion: WHATSAPP_SESSION_INFO_VERSION,
    featureType: WHATSAPP_BUSINESS_APP_FEATURE_TYPE,
  };
}

export function parseWhatsAppEmbeddedSignupMessage(input: {
  origin: string;
  data: unknown;
}): EmbeddedSignupMessageParseResult {
  if (!isTrustedFacebookMessageOrigin(input.origin)) {
    return { accepted: false, reason: "UNTRUSTED_ORIGIN" };
  }

  const payload = parsedPayload(input.data);
  if (!payload) return { accepted: false, reason: "INVALID_PAYLOAD" };
  if (payload.type !== WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE) {
    return { accepted: false, reason: "UNRELATED_MESSAGE" };
  }
  const data = record(payload.data);
  if (!data) {
    return { accepted: false, reason: "CONTRADICTORY_SESSION_INFO" };
  }
  const event = sanitizedSessionEventName(payload.event);
  const version = sanitizedSessionVersion(payload.version);

  // Meta's current reference implementation treats current_step as progress,
  // independently of event/version. Presence (not truthiness) is deliberate.
  if (Object.prototype.hasOwnProperty.call(data, "current_step")) {
    return {
      accepted: true,
      message: {
        kind: "intermediate",
        type: WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE,
        event,
        version,
        currentStepPresent: true,
      },
    };
  }

  if (payload.event === "CANCEL") {
    const errorCode = safeShortString(data.error_code, 160);
    const hasError =
      errorCode !== null || safeShortString(data.error_message, 500) !== null;
    return {
      accepted: true,
      message: {
        kind: "cancel",
        type: WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE,
        event: "CANCEL",
        version,
        currentStep: null,
        errorCode,
        hasError,
      },
    };
  }

  if (payload.event === "ERROR") {
    const errorCode = safeShortString(data.error_code, 160);
    return {
      accepted: true,
      message: {
        kind: "error",
        type: WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE,
        event: "ERROR",
        version,
        errorCode,
      },
    };
  }

  const wabaId = optionalAssetId(data.waba_id);
  if (!wabaId) {
    return { accepted: false, reason: "CONTRADICTORY_SESSION_INFO" };
  }
  const phoneNumberId = optionalAssetId(data.phone_number_id) ?? null;
  const businessPortfolioId = optionalAssetId(data.business_id) ?? null;
  const adAccountIds = assetIdList(data.ad_account_ids) ?? [];
  const pageIds = assetIdList(data.page_ids) ?? [];
  const datasetIds = assetIdList(data.dataset_ids) ?? [];
  const catalogIds = assetIdList(data.catalog_ids) ?? [];
  const instagramAccountIds = assetIdList(data.instagram_account_ids) ?? [];
  const wabaIds = assetIdList(data.waba_ids) ?? [];
  return {
    accepted: true,
    message: {
      kind: "session",
      type: WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE,
      event,
      version,
      assets: {
        wabaId,
        phoneNumberId,
        businessPortfolioId,
        adAccountIds,
        pageIds,
        datasetIds,
        catalogIds,
        instagramAccountIds,
        wabaIds,
      },
    },
  };
}

/**
 * Rejected window messages are observational noise, not onboarding failures.
 * Only the closed set of accepted WA_EMBEDDED_SIGNUP events may change state.
 */
export function embeddedSignupMessageEffect(
  result: EmbeddedSignupMessageParseResult,
): EmbeddedSignupMessageEffect {
  if (result.accepted) return result.message.kind;
  return result.reason === "CONTRADICTORY_SESSION_INFO"
    ? "contradictory"
    : "ignore";
}

export function initialEmbeddedSignupHandshake(): EmbeddedSignupHandshakeState {
  return {
    authorizationCode: null,
    codeReceived: false,
    sessionCandidate: null,
    completionDispatched: false,
    completionAcknowledged: false,
  };
}

/**
 * The authorization code and SessionInfo are independent signals. The caller
 * keeps this state only inside a Qwik noSerialize session; once both exist the
 * code is scrubbed from state and a single combined backend effect is emitted.
 */
export function reduceEmbeddedSignupHandshake(
  current: EmbeddedSignupHandshakeState,
  action: EmbeddedSignupHandshakeAction,
): EmbeddedSignupHandshakeTransition {
  let next = current;
  if (action.type === "completion_acknowledged") {
    if (!current.completionDispatched || current.completionAcknowledged) {
      return { state: current, effects: [] };
    }
    return {
      state: { ...current, completionAcknowledged: true },
      effects: [],
    };
  }

  if (action.type === "code_received") {
    const code = parseFacebookLoginCode({
      authResponse: { code: action.code },
    });
    if (!code || current.codeReceived || current.completionDispatched) {
      return { state: current, effects: [] };
    }
    next = {
      ...current,
      authorizationCode: code,
      codeReceived: true,
    };
  } else {
    if (current.sessionCandidate || current.completionDispatched) {
      return { state: current, effects: [] };
    }
    next = {
      ...current,
      sessionCandidate: action.message,
    };
  }

  if (!next.authorizationCode || !next.sessionCandidate) {
    return { state: next, effects: [] };
  }
  return {
    state: {
      ...next,
      authorizationCode: null,
      completionDispatched: true,
    },
    effects: [
      {
        type: "complete",
        code: next.authorizationCode,
        session: next.sessionCandidate,
      },
    ],
  };
}

export function embeddedSignupHandshakeComplete(
  state: EmbeddedSignupHandshakeState,
): boolean {
  return state.completionDispatched && state.completionAcknowledged;
}

export function onboardingAttemptBlocksStart(value: unknown): boolean {
  const onboarding = record(value);
  if (!onboarding || !safeShortString(onboarding.attemptId, 200)) return false;
  const state = safeShortString(onboarding.state, 80)?.toLowerCase();
  return !["cancelled", "completed", "expired", "failed"].includes(state ?? "");
}
