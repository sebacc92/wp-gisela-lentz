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

export interface EmbeddedSignupFinishEvent {
  kind: "finish";
  type: typeof WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE;
  event: typeof WHATSAPP_BUSINESS_APP_FINISH_EVENT;
  version: 3;
  assets: EmbeddedSignupAssets;
}

export interface EmbeddedSignupCancelEvent {
  kind: "cancel";
  type: typeof WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE;
  event: "CANCEL";
  version: 3;
  currentStep: string | null;
  errorCode: string | null;
  hasError: boolean;
}

export interface EmbeddedSignupErrorEvent {
  kind: "error";
  type: typeof WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE;
  event: "ERROR";
  version: 3;
  errorCode: string | null;
}

export type EmbeddedSignupMessage =
  | EmbeddedSignupFinishEvent
  | EmbeddedSignupCancelEvent
  | EmbeddedSignupErrorEvent;

export type EmbeddedSignupMessageRejection =
  | "UNTRUSTED_ORIGIN"
  | "INVALID_PAYLOAD"
  | "UNRELATED_MESSAGE"
  | "UNSUPPORTED_VERSION"
  | "UNEXPECTED_EVENT"
  | "INVALID_ASSETS";

export type EmbeddedSignupMessageParseResult =
  | { accepted: true; message: EmbeddedSignupMessage }
  | { accepted: false; reason: EmbeddedSignupMessageRejection };

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

export type EmbeddedSignupMessageSourceBinding<T> =
  | { accepted: true; source: T }
  | {
      accepted: false;
      source: T | null;
      reason: "MISSING_SOURCE" | "UNEXPECTED_SOURCE";
    };

/**
 * Meta's FINISH payload has no application attempt identifier. Bind the first
 * non-null source object accepted for this in-memory session and reject every
 * different source afterwards. Object identity is intentionally used: no
 * source data is serialized or trusted as an identifier.
 */
export function bindEmbeddedSignupMessageSource<T>(
  current: T | null,
  candidate: T | null,
): EmbeddedSignupMessageSourceBinding<T> {
  if (candidate === null) {
    return { accepted: false, source: current, reason: "MISSING_SOURCE" };
  }
  if (current !== null && current !== candidate) {
    return { accepted: false, source: current, reason: "UNEXPECTED_SOURCE" };
  }
  return { accepted: true, source: candidate };
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
  codeDispatched: boolean;
  finish: EmbeddedSignupFinishEvent | null;
  finishDispatched: boolean;
  exchangeAcknowledged: boolean;
  finishAcknowledged: boolean;
}

export type EmbeddedSignupHandshakeAction =
  | { type: "code_received"; code: string }
  | { type: "finish_received"; message: EmbeddedSignupFinishEvent }
  | { type: "exchange_acknowledged" }
  | { type: "finish_acknowledged" };

export type EmbeddedSignupHandshakeEffect =
  | {
      type: "exchange";
      code: string;
      finish: EmbeddedSignupFinishEvent | null;
    }
  | { type: "finish"; message: EmbeddedSignupFinishEvent };

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
  if (payload.event === WHATSAPP_BUSINESS_APP_FINISH_EVENT) {
    if (payload.version !== 3) {
      return { accepted: false, reason: "UNSUPPORTED_VERSION" };
    }
    const data = record(payload.data);
    if (!data) return { accepted: false, reason: "INVALID_PAYLOAD" };
    const wabaId = optionalAssetId(data.waba_id);
    const phoneNumberId = optionalAssetId(data.phone_number_id);
    const businessPortfolioId = optionalAssetId(data.business_id);
    const adAccountIds = assetIdList(data.ad_account_ids);
    const pageIds = assetIdList(data.page_ids);
    const datasetIds = assetIdList(data.dataset_ids);
    const catalogIds = assetIdList(data.catalog_ids);
    const instagramAccountIds = assetIdList(data.instagram_account_ids);
    const wabaIds = assetIdList(data.waba_ids);
    const assetLists = [
      adAccountIds,
      pageIds,
      datasetIds,
      catalogIds,
      instagramAccountIds,
      wabaIds,
    ];
    if (
      !wabaId ||
      phoneNumberId === undefined ||
      businessPortfolioId === undefined ||
      adAccountIds === null ||
      pageIds === null ||
      datasetIds === null ||
      catalogIds === null ||
      instagramAccountIds === null ||
      wabaIds === null ||
      assetLists.reduce((total, list) => total + (list?.length ?? 0), 0) >
        MAX_EMBEDDED_SIGNUP_ASSET_IDS ||
      (wabaIds.length > 0 && !wabaIds.includes(wabaId))
    ) {
      return { accepted: false, reason: "INVALID_ASSETS" };
    }
    return {
      accepted: true,
      message: {
        kind: "finish",
        type: WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE,
        event: WHATSAPP_BUSINESS_APP_FINISH_EVENT,
        version: 3,
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

  if (payload.event === "CANCEL") {
    // Meta's published CANCEL examples omit `version`, while FINISH v3 carries
    // it. Accept an omitted version for cancellation, but never a conflicting
    // one, so a real abandonment can always release the active attempt.
    if (payload.version !== undefined && payload.version !== 3) {
      return { accepted: false, reason: "UNSUPPORTED_VERSION" };
    }
    const data = record(payload.data);
    if (!data) return { accepted: false, reason: "INVALID_PAYLOAD" };
    const currentStep = safeShortString(data.current_step, 160);
    const errorCode = safeShortString(data.error_code, 160);
    const hasError =
      errorCode !== null || safeShortString(data.error_message, 500) !== null;
    if (
      (data.current_step !== undefined && currentStep === null) ||
      (data.error_code !== undefined && errorCode === null)
    ) {
      return { accepted: false, reason: "INVALID_PAYLOAD" };
    }
    return {
      accepted: true,
      message: {
        kind: "cancel",
        type: WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE,
        event: "CANCEL",
        version: 3,
        currentStep,
        errorCode,
        hasError,
      },
    };
  }

  if (payload.event === "ERROR") {
    if (payload.version !== undefined && payload.version !== 3) {
      return { accepted: false, reason: "UNSUPPORTED_VERSION" };
    }
    const data = record(payload.data);
    if (!data) return { accepted: false, reason: "INVALID_PAYLOAD" };
    const errorCode = safeShortString(data.error_code, 160);
    if (data.error_code !== undefined && errorCode === null) {
      return { accepted: false, reason: "INVALID_PAYLOAD" };
    }
    return {
      accepted: true,
      message: {
        kind: "error",
        type: WHATSAPP_EMBEDDED_SIGNUP_MESSAGE_TYPE,
        event: "ERROR",
        version: 3,
        errorCode,
      },
    };
  }

  return { accepted: false, reason: "UNEXPECTED_EVENT" };
}

export function initialEmbeddedSignupHandshake(): EmbeddedSignupHandshakeState {
  return {
    codeDispatched: false,
    finish: null,
    finishDispatched: false,
    exchangeAcknowledged: false,
    finishAcknowledged: false,
  };
}

/**
 * The authorization code is emitted only as a transient effect. It is never
 * copied into the returned state, so callers can dispatch it immediately and
 * cannot accidentally persist it with the UI state or a page snapshot.
 */
export function reduceEmbeddedSignupHandshake(
  current: EmbeddedSignupHandshakeState,
  action: EmbeddedSignupHandshakeAction,
): EmbeddedSignupHandshakeTransition {
  if (action.type === "code_received") {
    const code = parseFacebookLoginCode({
      authResponse: { code: action.code },
    });
    if (!code || current.codeDispatched) {
      return { state: current, effects: [] };
    }
    return {
      state: { ...current, codeDispatched: true },
      effects: [{ type: "exchange", code, finish: current.finish }],
    };
  }

  if (action.type === "finish_received") {
    if (current.finishDispatched) {
      return { state: current, effects: [] };
    }
    return {
      state: {
        ...current,
        finish: action.message,
        finishDispatched: true,
      },
      effects: [{ type: "finish", message: action.message }],
    };
  }

  if (action.type === "exchange_acknowledged") {
    return {
      state: { ...current, exchangeAcknowledged: true },
      effects: [],
    };
  }

  return {
    state: { ...current, finishAcknowledged: true },
    effects: [],
  };
}

export function embeddedSignupHandshakeComplete(
  state: EmbeddedSignupHandshakeState,
): boolean {
  return state.exchangeAcknowledged && state.finishAcknowledged;
}

export function onboardingAttemptBlocksStart(value: unknown): boolean {
  const onboarding = record(value);
  if (!onboarding || !safeShortString(onboarding.attemptId, 200)) return false;
  const state = safeShortString(onboarding.state, 80)?.toLowerCase();
  return !["cancelled", "completed", "expired", "failed"].includes(state ?? "");
}
