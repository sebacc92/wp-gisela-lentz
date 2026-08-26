export const META_GRAPH_ROOT = "https://graph.facebook.com";
export const CURRENT_META_GRAPH_VERSION = "v26.0";
export const EMBEDDED_SIGNUP_CODE_LIFETIME_MS = 30_000;
export const META_GRAPH_TIMEOUT_MS = 8_000;
export const META_GRAPH_MAX_RESPONSE_BYTES = 256 * 1_024;
export const SYNC_DEADLINE_SAFETY_MARGIN_MS = 2 * 60 * 1_000;

export const REQUIRED_WHATSAPP_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
] as const;

const RETRYABLE_META_GRAPH_CODES = new Set([4, 80007, 130429, 131056]);
const NON_RETRYABLE_META_POLICY_CODES = new Set([
  10, 200, 368, 131026, 131031, 131047, 131048, 131049, 132000, 132001, 132005,
  132007, 132012, 132015, 132016,
]);

export interface EmbeddedSignupConfiguration {
  appId: string;
  configurationId: string;
  appSecret: string;
  apiVersion: string;
}

export interface PublicEmbeddedSignupConfiguration {
  appId: string;
  configurationId: string;
  apiVersion: string;
  sessionInfoVersion: "3";
  featureType: "whatsapp_business_app_onboarding";
}

export interface MetaBusinessToken {
  accessToken: string;
  tokenType: string | null;
  expiresIn: number | null;
}

export interface ValidatedWhatsAppAssets {
  businessPortfolioId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  tokenExpiresAt: string | null;
  grantedScopes: string[];
  tokenMetadata: BusinessTokenMetadata;
}

export interface BusinessTokenGranularScope {
  scope: string;
  targetIds: string[];
}

export interface BusinessTokenMetadata {
  isValid: boolean;
  appId: string | null;
  scopes: string[];
  granularScopes: BusinessTokenGranularScope[];
  targetIds: string[];
  expiresAt: string | null;
  dataAccessExpiresAt: string | null;
  validatedAt: string;
}

export interface SyncRequestAcceptance {
  requestId: string;
  messagingProduct: "whatsapp";
}

export type MetaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class MetaEmbeddedSignupError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  readonly credentialInvalid: boolean;

  constructor(
    code: string,
    options: {
      status?: number;
      retryable?: boolean;
      outcomeUnknown?: boolean;
      credentialInvalid?: boolean;
    } = {},
  ) {
    super(code);
    this.name = "MetaEmbeddedSignupError";
    this.code = code;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.credentialInvalid = options.credentialInvalid ?? false;
  }
}

export interface EmbeddedSignupCompletionFailure {
  code: string;
  retryable: boolean;
  status: number;
}

/**
 * SQL domain rejections are deterministic and must never cause another Graph
 * validation pass. Transport/PostgREST failures without a domain code retain
 * the durable retry path because their database outcome is unknown.
 */
export function classifyEmbeddedSignupCompletionFailure(
  error: { message?: string } | null,
): EmbeddedSignupCompletionFailure {
  const domainCode = error?.message?.match(/WHATSAPP_[A-Z0-9_]{3,100}/)?.[0];
  return domainCode
    ? { code: domainCode, retryable: false, status: 409 }
    : {
        code: "WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_FAILED",
        retryable: true,
        status: 500,
      };
}

export function canStartOnboardingGraphJob(
  deadlineAt: string | null,
  nowMs = Date.now(),
): boolean {
  if (deadlineAt === null) return true;
  const deadlineMs = new Date(deadlineAt).getTime();
  return (
    Number.isFinite(deadlineMs) &&
    deadlineMs > nowMs + SYNC_DEADLINE_SAFETY_MARGIN_MS
  );
}

function requiredValue(value: string | undefined, code: string): string {
  const clean = value?.trim();
  if (!clean) {
    throw new MetaEmbeddedSignupError(code, { status: 503 });
  }
  return clean;
}

function requiredOpaqueCredential(
  value: string | undefined,
  code: string,
): string {
  if (!value || /[\r\n]/.test(value)) {
    throw new MetaEmbeddedSignupError(code, { status: 503 });
  }
  return value;
}

function numericMetaId(value: string, code: string): string {
  const clean = value.trim();
  if (!/^[0-9]{5,64}$/.test(clean)) {
    throw new MetaEmbeddedSignupError(code, { status: 503 });
  }
  return clean;
}

function validApiVersion(value: string): string {
  const clean = value.trim();
  if (!/^v[1-9][0-9]{0,2}\.0$/.test(clean)) {
    throw new MetaEmbeddedSignupError("META_GRAPH_API_VERSION_INVALID", {
      status: 503,
    });
  }
  if (clean !== CURRENT_META_GRAPH_VERSION) {
    throw new MetaEmbeddedSignupError("META_GRAPH_API_VERSION_UNSUPPORTED", {
      status: 503,
    });
  }
  return clean;
}

export function embeddedSignupConfiguration(
  env: (name: string) => string | undefined,
): EmbeddedSignupConfiguration {
  return {
    appId: numericMetaId(
      requiredValue(env("META_APP_ID"), "META_APP_ID_MISSING"),
      "META_APP_ID_INVALID",
    ),
    configurationId: numericMetaId(
      requiredValue(
        env("META_EMBEDDED_SIGNUP_CONFIG_ID"),
        "META_EMBEDDED_SIGNUP_CONFIG_ID_MISSING",
      ),
      "META_EMBEDDED_SIGNUP_CONFIG_ID_INVALID",
    ),
    appSecret: requiredOpaqueCredential(
      env("META_APP_SECRET"),
      "META_APP_SECRET_MISSING",
    ),
    apiVersion: validApiVersion(
      requiredValue(
        env("WHATSAPP_GRAPH_API_VERSION"),
        "META_GRAPH_API_VERSION_MISSING",
      ),
    ),
  };
}

export function whatsappEmbeddedSignupEnabled(
  env: (name: string) => string | undefined,
): boolean {
  return (
    env("WHATSAPP_EMBEDDED_SIGNUP_ENABLED")?.trim().toLowerCase() === "true"
  );
}

export function publicEmbeddedSignupConfiguration(
  config: EmbeddedSignupConfiguration,
): PublicEmbeddedSignupConfiguration {
  return {
    appId: config.appId,
    configurationId: config.configurationId,
    apiVersion: config.apiVersion,
    sessionInfoVersion: "3",
    featureType: "whatsapp_business_app_onboarding",
  };
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[0-9]{5,64}$/.test(value)) {
    throw new MetaEmbeddedSignupError(code, { status: 422 });
  }
  return value;
}

function cleanText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= maximumLength ? clean : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalidGraphRead(code: string): never {
  throw new MetaEmbeddedSignupError(code, {
    status: 502,
    retryable: true,
  });
}

function graphResponseId(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[0-9]{5,64}$/.test(value)) {
    invalidGraphRead(code);
  }
  return value;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function metaUrl(
  apiVersion: string,
  path: string,
  query: Record<string, string> = {},
): URL {
  if (!/^\/[A-Za-z0-9_?.,{}-]+(?:\/[A-Za-z0-9_?.,{}-]+)*$/.test(path)) {
    throw new MetaEmbeddedSignupError("META_GRAPH_PATH_INVALID");
  }
  const url = new URL(`/${apiVersion}${path}`, META_GRAPH_ROOT);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function graphJson(
  operation: string,
  url: URL,
  options: {
    method?: "GET" | "POST" | "DELETE";
    bearer?: string;
    body?: Record<string, unknown>;
    timeoutMs?: number;
    outcomeUnknownOnNetworkError?: boolean;
    customerCredentialOnUnauthorized?: boolean;
    fetchImpl?: MetaFetch;
  } = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? META_GRAPH_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: options.method ?? "GET",
      // Graph calls may carry a customer token in Authorization and the
      // documented code exchange necessarily carries short-lived secrets in
      // its query. Never forward either credential across an HTTP redirect.
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(options.bearer
          ? { Authorization: `Bearer ${options.bearer}` }
          : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      const declaredBytes = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredBytes) &&
        declaredBytes > META_GRAPH_MAX_RESPONSE_BYTES
      ) {
        throw new Error("response too large");
      }
      const raw = await response.text();
      if (
        new TextEncoder().encode(raw).byteLength > META_GRAPH_MAX_RESPONSE_BYTES
      ) {
        throw new Error("response too large");
      }
      payload = JSON.parse(raw);
    } catch {
      const transientResponse =
        response.ok ||
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      const outcomeUnknown =
        options.outcomeUnknownOnNetworkError === true &&
        (response.ok || response.status === 408 || response.status >= 500);
      throw new MetaEmbeddedSignupError(`${operation}_INVALID_RESPONSE`, {
        status: 502,
        retryable: transientResponse && !outcomeUnknown,
        outcomeUnknown,
      });
    }

    const record = asRecord(payload);
    const hasProviderError = Object.prototype.hasOwnProperty.call(
      record,
      "error",
    );
    const providerError = asRecord(record.error);
    const hasStructuredProviderError = Object.keys(providerError).length > 0;
    if (response.ok && hasProviderError && !hasStructuredProviderError) {
      throw new MetaEmbeddedSignupError(`${operation}_INVALID_RESPONSE`, {
        status: 502,
        retryable: options.outcomeUnknownOnNetworkError !== true,
        outcomeUnknown: options.outcomeUnknownOnNetworkError === true,
      });
    }

    // Graph can return a semantic error envelope with HTTP 200. Treat a
    // structured top-level error as a provider rejection regardless of the
    // transport status; otherwise a lookup could be mistaken for an empty
    // success and cause an unsafe follow-up mutation.
    if (!response.ok || hasStructuredProviderError) {
      const graphCode =
        typeof providerError.code === "number" &&
        Number.isSafeInteger(providerError.code)
          ? providerError.code
          : null;
      const credentialInvalid =
        options.customerCredentialOnUnauthorized === true &&
        (graphCode === 190 || response.status === 401);
      const policyRejected =
        graphCode !== null && NON_RETRYABLE_META_POLICY_CODES.has(graphCode);
      const providerTransient =
        providerError.is_transient === true ||
        (graphCode !== null && RETRYABLE_META_GRAPH_CODES.has(graphCode));
      const transportTransient =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      const outcomeUnknown =
        options.outcomeUnknownOnNetworkError === true &&
        !credentialInvalid &&
        !policyRejected &&
        (response.status === 408 || response.status >= 500);
      const retryable =
        !credentialInvalid &&
        !policyRejected &&
        (transportTransient || providerTransient) &&
        !outcomeUnknown;
      throw new MetaEmbeddedSignupError(
        credentialInvalid
          ? `${operation}_CREDENTIAL_INVALID`
          : `${operation}_REJECTED`,
        {
          status: 502,
          retryable,
          outcomeUnknown,
          credentialInvalid,
        },
      );
    }
    if (Object.keys(record).length === 0) {
      throw new MetaEmbeddedSignupError(`${operation}_INVALID_RESPONSE`, {
        status: 502,
        retryable: options.outcomeUnknownOnNetworkError !== true,
        outcomeUnknown: options.outcomeUnknownOnNetworkError === true,
      });
    }
    return record;
  } catch (error) {
    if (error instanceof MetaEmbeddedSignupError) throw error;
    throw new MetaEmbeddedSignupError(`${operation}_NETWORK_ERROR`, {
      status: 502,
      retryable: options.outcomeUnknownOnNetworkError !== true,
      outcomeUnknown: options.outcomeUnknownOnNetworkError === true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function exchangeEmbeddedSignupCode(input: {
  code: string;
  receivedAtMs: number;
  config: EmbeddedSignupConfiguration;
  fetchImpl?: MetaFetch;
  now?: () => number;
}): Promise<MetaBusinessToken> {
  const code = input.code;
  if (!code || code.length > 4_096 || /[\r\n]/.test(code)) {
    throw new MetaEmbeddedSignupError("EMBEDDED_SIGNUP_CODE_INVALID", {
      status: 400,
    });
  }
  const now = input.now ?? Date.now;
  const startedAt = now();
  if (
    !Number.isFinite(input.receivedAtMs) ||
    input.receivedAtMs > startedAt ||
    input.receivedAtMs < 0
  ) {
    throw new MetaEmbeddedSignupError("EMBEDDED_SIGNUP_CODE_TIME_INVALID", {
      status: 400,
    });
  }
  const remaining =
    input.receivedAtMs + EMBEDDED_SIGNUP_CODE_LIFETIME_MS - startedAt;
  if (remaining <= 0) {
    throw new MetaEmbeddedSignupError("EMBEDDED_SIGNUP_CODE_EXPIRED", {
      status: 409,
    });
  }

  // Meta's documented exchange is a server-side GET. The URL is constructed
  // only in memory and is never included in logs, errors or API responses.
  const url = new URL(
    `/${input.config.apiVersion}/oauth/access_token`,
    META_GRAPH_ROOT,
  );
  url.searchParams.set("client_id", input.config.appId);
  url.searchParams.set("client_secret", input.config.appSecret);
  url.searchParams.set("code", code);
  const payload = await graphJson("TOKEN_EXCHANGE", url, {
    timeoutMs: Math.min(META_GRAPH_TIMEOUT_MS, remaining),
    fetchImpl: input.fetchImpl,
    outcomeUnknownOnNetworkError: true,
  });
  const accessToken = payload.access_token;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    /[\r\n]/.test(accessToken)
  ) {
    throw new MetaEmbeddedSignupError("TOKEN_EXCHANGE_INVALID_RESPONSE", {
      status: 502,
      outcomeUnknown: true,
    });
  }
  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isSafeInteger(payload.expires_in) &&
    payload.expires_in > 0
      ? payload.expires_in
      : null;
  return {
    accessToken,
    tokenType: cleanText(payload.token_type, 40),
    expiresIn,
  };
}

function unixTimestampIso(value: unknown, code: string): string | null {
  if (value === undefined || value === null || value === 0) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000
  ) {
    invalidGraphRead(code);
  }
  return new Date(value * 1_000).toISOString();
}

async function appAccessToken(input: {
  config: EmbeddedSignupConfiguration;
  fetchImpl?: MetaFetch;
}): Promise<string> {
  // Meta documents the client_credentials exchange for App Access Tokens. It
  // is generated for each validation request, remains server-side and is never
  // persisted or returned to the browser.
  const url = metaUrl(input.config.apiVersion, "/oauth/access_token", {
    client_id: input.config.appId,
    client_secret: input.config.appSecret,
    grant_type: "client_credentials",
  });
  const payload = await graphJson("APP_TOKEN_EXCHANGE", url, {
    fetchImpl: input.fetchImpl,
  });
  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token ||
    /[\r\n]/.test(payload.access_token)
  ) {
    invalidGraphRead("APP_TOKEN_EXCHANGE_INVALID_RESPONSE");
  }
  return payload.access_token;
}

export async function inspectBusinessToken(input: {
  businessToken: string;
  config: EmbeddedSignupConfiguration;
  fetchImpl?: MetaFetch;
  now?: () => number;
}): Promise<BusinessTokenMetadata> {
  const debuggerToken = await appAccessToken(input);
  const url = metaUrl(input.config.apiVersion, "/debug_token", {
    input_token: input.businessToken,
  });
  const payload = await graphJson("TOKEN_DEBUG", url, {
    bearer: debuggerToken,
    fetchImpl: input.fetchImpl,
  });
  const data = recordOrNull(payload.data);
  if (!data || typeof data.is_valid !== "boolean") {
    invalidGraphRead("TOKEN_DEBUG_INVALID_RESPONSE");
  }
  const appId =
    data.app_id === undefined || data.app_id === null
      ? null
      : typeof data.app_id === "string" && /^[0-9]{5,64}$/.test(data.app_id)
        ? data.app_id
        : invalidGraphRead("TOKEN_DEBUG_INVALID_RESPONSE");
  const scopes = data.scopes ?? [];
  const granularScopes = data.granular_scopes ?? [];
  if (
    (data.is_valid &&
      (appId === null ||
        data.scopes === undefined ||
        data.granular_scopes === undefined)) ||
    !Array.isArray(scopes) ||
    scopes.some((value) => typeof value !== "string") ||
    !Array.isArray(granularScopes)
  ) {
    invalidGraphRead("TOKEN_DEBUG_INVALID_RESPONSE");
  }
  const normalizedGranularScopes: BusinessTokenGranularScope[] = [];
  const targetIds = new Set<string>();
  for (const granularValue of granularScopes) {
    const granular = recordOrNull(granularValue);
    if (
      !granular ||
      typeof granular.scope !== "string" ||
      !Array.isArray(granular.target_ids) ||
      granular.target_ids.some(
        (target) => typeof target !== "string" || !/^[0-9]{5,64}$/.test(target),
      )
    ) {
      invalidGraphRead("TOKEN_DEBUG_INVALID_RESPONSE");
    }
    const normalizedTargets = [
      ...new Set(granular.target_ids as string[]),
    ].sort();
    normalizedTargets.forEach((target) => targetIds.add(target));
    normalizedGranularScopes.push({
      scope: granular.scope,
      targetIds: normalizedTargets,
    });
  }
  normalizedGranularScopes.sort((left, right) =>
    left.scope.localeCompare(right.scope),
  );
  const now = input.now ?? Date.now;
  return {
    isValid: data.is_valid,
    appId,
    scopes: [...new Set(scopes as string[])].sort(),
    granularScopes: normalizedGranularScopes,
    targetIds: [...targetIds].sort(),
    expiresAt: unixTimestampIso(
      data.expires_at,
      "TOKEN_DEBUG_INVALID_RESPONSE",
    ),
    dataAccessExpiresAt: unixTimestampIso(
      data.data_access_expires_at,
      "TOKEN_DEBUG_INVALID_RESPONSE",
    ),
    validatedAt: new Date(now()).toISOString(),
  };
}

export function assertBusinessTokenAuthorization(input: {
  metadata: BusinessTokenMetadata;
  expectedAppId: string;
  expectedWabaId: string;
}): void {
  if (!input.metadata.isValid || input.metadata.appId !== input.expectedAppId) {
    throw new MetaEmbeddedSignupError("BUSINESS_TOKEN_INVALID", {
      status: 422,
      credentialInvalid: true,
    });
  }
  for (const requiredScope of REQUIRED_WHATSAPP_SCOPES) {
    if (!input.metadata.scopes.includes(requiredScope)) {
      throw new MetaEmbeddedSignupError("BUSINESS_TOKEN_SCOPE_MISSING", {
        status: 422,
      });
    }
    const granular = input.metadata.granularScopes.find(
      (candidate) => candidate.scope === requiredScope,
    );
    if (!granular?.targetIds.includes(input.expectedWabaId)) {
      throw new MetaEmbeddedSignupError("BUSINESS_TOKEN_WABA_MISMATCH", {
        status: 422,
      });
    }
  }
}

export function assertBusinessTokenLifetime(
  metadata: BusinessTokenMetadata,
  minimumRemainingMs = 0,
): void {
  const validatedAt = new Date(metadata.validatedAt).getTime();
  if (
    !Number.isFinite(validatedAt) ||
    !Number.isSafeInteger(minimumRemainingMs) ||
    minimumRemainingMs < 0
  ) {
    throw new MetaEmbeddedSignupError("BUSINESS_TOKEN_METADATA_INVALID", {
      status: 422,
    });
  }
  const minimumExpiry = validatedAt + minimumRemainingMs;
  for (const expiry of [metadata.expiresAt, metadata.dataAccessExpiresAt]) {
    if (expiry === null) continue;
    const expiryMs = new Date(expiry).getTime();
    if (!Number.isFinite(expiryMs) || expiryMs <= minimumExpiry) {
      throw new MetaEmbeddedSignupError("BUSINESS_TOKEN_EXPIRED", {
        status: 422,
        credentialInvalid: true,
      });
    }
  }
}

async function allPhoneNumbers(input: {
  wabaId: string;
  businessToken: string;
  config: EmbeddedSignupConfiguration;
  fetchImpl?: MetaFetch;
}): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let after: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 10; page += 1) {
    const url = metaUrl(
      input.config.apiVersion,
      `/${input.wabaId}/phone_numbers`,
      {
        fields: "id,display_phone_number,verified_name,status",
        limit: "100",
        ...(after ? { after } : {}),
      },
    );
    const payload = await graphJson("PHONE_LIST", url, {
      bearer: input.businessToken,
      customerCredentialOnUnauthorized: true,
      fetchImpl: input.fetchImpl,
    });
    if (!Array.isArray(payload.data)) {
      invalidGraphRead("PHONE_LIST_INVALID_RESPONSE");
    }
    const pageRows = payload.data.map((value) => {
      const row = recordOrNull(value);
      if (!row) invalidGraphRead("PHONE_LIST_INVALID_RESPONSE");
      graphResponseId(row.id, "PHONE_LIST_INVALID_RESPONSE");
      return row;
    });
    rows.push(...pageRows);
    if (payload.paging === undefined || payload.paging === null) return rows;
    const paging = recordOrNull(payload.paging);
    if (!paging) invalidGraphRead("PHONE_LIST_PAGINATION_INVALID");
    if (
      paging.next === undefined ||
      paging.next === null ||
      paging.next === ""
    ) {
      return rows;
    }
    if (typeof paging.next !== "string") {
      invalidGraphRead("PHONE_LIST_PAGINATION_INVALID");
    }
    const cursor = cleanText(asRecord(paging.cursors).after, 512);
    if (!cursor || seenCursors.has(cursor)) {
      throw new MetaEmbeddedSignupError("PHONE_LIST_PAGINATION_INVALID", {
        status: 502,
        retryable: true,
      });
    }
    seenCursors.add(cursor);
    after = cursor;
  }
  throw new MetaEmbeddedSignupError("PHONE_LIST_PAGINATION_LIMIT", {
    status: 502,
  });
}

export async function validateWhatsAppAssets(input: {
  businessToken: string;
  expectedWabaId: string;
  expectedPhoneNumberId?: string | null;
  expectedBusinessPortfolioId?: string | null;
  config: EmbeddedSignupConfiguration;
  inspectedTokenMetadata?: BusinessTokenMetadata;
  fetchImpl?: MetaFetch;
}): Promise<ValidatedWhatsAppAssets> {
  const wabaId = safeId(input.expectedWabaId, "WABA_ID_INVALID");
  const expectedPhone = input.expectedPhoneNumberId
    ? safeId(input.expectedPhoneNumberId, "PHONE_NUMBER_ID_INVALID")
    : null;
  const expectedBusiness = input.expectedBusinessPortfolioId
    ? safeId(input.expectedBusinessPortfolioId, "BUSINESS_PORTFOLIO_ID_INVALID")
    : null;
  const tokenMetadata =
    input.inspectedTokenMetadata ??
    (await inspectBusinessToken({
      businessToken: input.businessToken,
      config: input.config,
      fetchImpl: input.fetchImpl,
    }));
  assertBusinessTokenAuthorization({
    metadata: tokenMetadata,
    expectedAppId: input.config.appId,
    expectedWabaId: wabaId,
  });
  const wabaUrl = metaUrl(input.config.apiVersion, `/${wabaId}`, {
    fields: "id,owner_business_info",
  });
  const waba = await graphJson("WABA_LOOKUP", wabaUrl, {
    bearer: input.businessToken,
    customerCredentialOnUnauthorized: true,
    fetchImpl: input.fetchImpl,
  });
  const returnedWabaId = graphResponseId(
    waba.id,
    "WABA_LOOKUP_INVALID_RESPONSE",
  );
  if (returnedWabaId !== wabaId) {
    throw new MetaEmbeddedSignupError("WABA_LOOKUP_MISMATCH", { status: 422 });
  }
  const owner = recordOrNull(waba.owner_business_info);
  if (!owner) invalidGraphRead("WABA_LOOKUP_INVALID_RESPONSE");
  const businessPortfolioId = graphResponseId(
    owner.id,
    "WABA_LOOKUP_INVALID_RESPONSE",
  );
  if (expectedBusiness && expectedBusiness !== businessPortfolioId) {
    throw new MetaEmbeddedSignupError("BUSINESS_PORTFOLIO_ID_MISMATCH", {
      status: 422,
    });
  }

  const phoneRows = await allPhoneNumbers({
    wabaId,
    businessToken: input.businessToken,
    config: input.config,
    fetchImpl: input.fetchImpl,
  });
  const uniquePhoneRows = new Map<string, Record<string, unknown>>();
  for (const row of phoneRows) {
    const id = graphResponseId(row.id, "PHONE_LIST_INVALID_RESPONSE");
    uniquePhoneRows.set(id, row);
  }
  let rowsToValidate: Array<[string, Record<string, unknown>]>;
  if (expectedPhone) {
    const expectedRow = uniquePhoneRows.get(expectedPhone);
    if (!expectedRow) {
      throw new MetaEmbeddedSignupError("PHONE_NUMBER_WABA_MISMATCH", {
        status: 422,
      });
    }
    rowsToValidate = [[expectedPhone, expectedRow]];
  } else {
    rowsToValidate = [...uniquePhoneRows.entries()];
  }
  if (rowsToValidate.length === 0 || rowsToValidate.length > 25) {
    throw new MetaEmbeddedSignupError("PHONE_NUMBER_SELECTION_AMBIGUOUS", {
      status: 422,
    });
  }

  const checkedPhones = await Promise.all(
    rowsToValidate.map(async ([phoneNumberId, phoneRow]) => {
      const phoneUrl = metaUrl(input.config.apiVersion, `/${phoneNumberId}`, {
        fields: "id,display_phone_number,is_on_biz_app,platform_type",
      });
      const phone = await graphJson("PHONE_LOOKUP", phoneUrl, {
        bearer: input.businessToken,
        customerCredentialOnUnauthorized: true,
        fetchImpl: input.fetchImpl,
      });
      const returnedPhoneId = graphResponseId(
        phone.id,
        "PHONE_LOOKUP_INVALID_RESPONSE",
      );
      if (
        typeof phone.is_on_biz_app !== "boolean" ||
        typeof phone.platform_type !== "string"
      ) {
        invalidGraphRead("PHONE_LOOKUP_INVALID_RESPONSE");
      }
      if (returnedPhoneId !== phoneNumberId) {
        throw new MetaEmbeddedSignupError("PHONE_LOOKUP_MISMATCH", {
          status: 422,
        });
      }
      return { phoneNumberId, phoneRow, phone };
    }),
  );
  const coexistencePhones = checkedPhones.filter(
    ({ phone }) =>
      phone.is_on_biz_app === true && phone.platform_type === "CLOUD_API",
  );
  if (coexistencePhones.length !== 1) {
    throw new MetaEmbeddedSignupError("PHONE_NOT_COEXISTENCE", {
      status: 422,
    });
  }
  const { phoneNumberId, phoneRow, phone } = coexistencePhones[0];
  const expiryCandidates = [
    tokenMetadata.expiresAt,
    tokenMetadata.dataAccessExpiresAt,
  ].filter((value): value is string => value !== null);
  const tokenExpiresAt = expiryCandidates.sort()[0] ?? null;
  return {
    businessPortfolioId,
    wabaId,
    phoneNumberId,
    displayPhoneNumber:
      cleanText(phone.display_phone_number, 40) ??
      cleanText(phoneRow?.display_phone_number, 40),
    tokenExpiresAt,
    grantedScopes: tokenMetadata.scopes,
    tokenMetadata,
  };
}

async function listSubscribedAppIds(input: {
  wabaId: string;
  businessToken: string;
  config: EmbeddedSignupConfiguration;
  fetchImpl?: MetaFetch;
}): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 10; page += 1) {
    const url = metaUrl(
      input.config.apiVersion,
      `/${input.wabaId}/subscribed_apps`,
      {
        limit: "100",
        ...(after ? { after } : {}),
      },
    );
    const payload = await graphJson("SUBSCRIBED_APPS_LOOKUP", url, {
      bearer: input.businessToken,
      customerCredentialOnUnauthorized: true,
      fetchImpl: input.fetchImpl,
    });
    if (!Array.isArray(payload.data)) {
      invalidGraphRead("SUBSCRIBED_APPS_LOOKUP_INVALID_RESPONSE");
    }
    for (const appValue of payload.data) {
      const app = recordOrNull(appValue);
      if (!app) {
        invalidGraphRead("SUBSCRIBED_APPS_LOOKUP_INVALID_RESPONSE");
      }
      const nested =
        app.whatsapp_business_api_data === undefined
          ? null
          : recordOrNull(app.whatsapp_business_api_data);
      if (app.whatsapp_business_api_data !== undefined && !nested) {
        invalidGraphRead("SUBSCRIBED_APPS_LOOKUP_INVALID_RESPONSE");
      }
      const nestedId = nested?.id;
      const appId = typeof nestedId === "string" ? nestedId : app.id;
      ids.add(
        graphResponseId(appId, "SUBSCRIBED_APPS_LOOKUP_INVALID_RESPONSE"),
      );
    }
    if (payload.paging === undefined || payload.paging === null) return ids;
    const paging = recordOrNull(payload.paging);
    if (!paging) {
      invalidGraphRead("SUBSCRIBED_APPS_PAGINATION_INVALID");
    }
    if (
      paging.next === undefined ||
      paging.next === null ||
      paging.next === ""
    ) {
      return ids;
    }
    if (typeof paging.next !== "string") {
      invalidGraphRead("SUBSCRIBED_APPS_PAGINATION_INVALID");
    }
    const cursor = cleanText(asRecord(paging.cursors).after, 512);
    if (!cursor || seenCursors.has(cursor)) {
      throw new MetaEmbeddedSignupError("SUBSCRIBED_APPS_PAGINATION_INVALID", {
        status: 502,
        retryable: true,
      });
    }
    seenCursors.add(cursor);
    after = cursor;
  }
  throw new MetaEmbeddedSignupError("SUBSCRIBED_APPS_PAGINATION_LIMIT", {
    status: 502,
  });
}

export async function ensureAppSubscribed(input: {
  wabaId: string;
  businessToken: string;
  config: EmbeddedSignupConfiguration;
  fetchImpl?: MetaFetch;
}): Promise<{ alreadySubscribed: boolean }> {
  const wabaId = safeId(input.wabaId, "WABA_ID_INVALID");
  const before = await listSubscribedAppIds({ ...input, wabaId });
  if (before.has(input.config.appId)) return { alreadySubscribed: true };

  const url = metaUrl(input.config.apiVersion, `/${wabaId}/subscribed_apps`);
  try {
    const payload = await graphJson("SUBSCRIBE_APP", url, {
      method: "POST",
      bearer: input.businessToken,
      customerCredentialOnUnauthorized: true,
      fetchImpl: input.fetchImpl,
      outcomeUnknownOnNetworkError: true,
    });
    if (payload.success !== true) {
      throw new MetaEmbeddedSignupError("SUBSCRIBE_APP_INVALID_RESPONSE", {
        status: 502,
        outcomeUnknown: true,
      });
    }
  } catch (error) {
    if (!(error instanceof MetaEmbeddedSignupError && error.outcomeUnknown)) {
      throw error;
    }
  }

  const after = await listSubscribedAppIds({ ...input, wabaId });
  if (!after.has(input.config.appId)) {
    throw new MetaEmbeddedSignupError("SUBSCRIBE_APP_NOT_CONFIRMED", {
      status: 502,
      retryable: true,
    });
  }
  return { alreadySubscribed: false };
}

export async function requestAppDataSync(input: {
  phoneNumberId: string;
  syncType: "smb_app_state_sync" | "history";
  businessToken: string;
  config: EmbeddedSignupConfiguration;
  fetchImpl?: MetaFetch;
}): Promise<SyncRequestAcceptance> {
  const phoneNumberId = safeId(input.phoneNumberId, "PHONE_NUMBER_ID_INVALID");
  const url = metaUrl(
    input.config.apiVersion,
    `/${phoneNumberId}/smb_app_data`,
  );
  const payload = await graphJson("APP_DATA_SYNC", url, {
    method: "POST",
    bearer: input.businessToken,
    customerCredentialOnUnauthorized: true,
    body: {
      messaging_product: "whatsapp",
      sync_type: input.syncType,
    },
    fetchImpl: input.fetchImpl,
    outcomeUnknownOnNetworkError: true,
  });
  const requestId = cleanText(payload.request_id, 240);
  if (payload.messaging_product !== "whatsapp" || !requestId) {
    throw new MetaEmbeddedSignupError("APP_DATA_SYNC_INVALID_RESPONSE", {
      status: 502,
      outcomeUnknown: true,
    });
  }
  return { requestId, messagingProduct: "whatsapp" };
}

export async function unsubscribeApp(input: {
  wabaId: string;
  businessToken: string;
  config: EmbeddedSignupConfiguration;
  fetchImpl?: MetaFetch;
}): Promise<{ alreadyUnsubscribed: boolean }> {
  const wabaId = safeId(input.wabaId, "WABA_ID_INVALID");
  const before = await listSubscribedAppIds({ ...input, wabaId });
  if (!before.has(input.config.appId)) return { alreadyUnsubscribed: true };
  const url = metaUrl(input.config.apiVersion, `/${wabaId}/subscribed_apps`);
  try {
    const payload = await graphJson("UNSUBSCRIBE_APP", url, {
      method: "DELETE",
      bearer: input.businessToken,
      customerCredentialOnUnauthorized: true,
      fetchImpl: input.fetchImpl,
      outcomeUnknownOnNetworkError: true,
    });
    if (payload.success !== true) {
      throw new MetaEmbeddedSignupError("UNSUBSCRIBE_APP_INVALID_RESPONSE", {
        status: 502,
        outcomeUnknown: true,
      });
    }
  } catch (error) {
    if (!(error instanceof MetaEmbeddedSignupError && error.outcomeUnknown)) {
      throw error;
    }
  }
  const after = await listSubscribedAppIds({ ...input, wabaId });
  if (after.has(input.config.appId)) {
    throw new MetaEmbeddedSignupError("UNSUBSCRIBE_APP_NOT_CONFIRMED", {
      status: 502,
      retryable: true,
    });
  }
  return { alreadyUnsubscribed: false };
}

export function safeEmbeddedSignupErrorCode(error: unknown): string {
  if (error instanceof MetaEmbeddedSignupError) return error.code;
  return "EMBEDDED_SIGNUP_INTERNAL_ERROR";
}
