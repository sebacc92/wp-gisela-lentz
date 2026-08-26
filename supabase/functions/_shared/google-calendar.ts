export const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOCATION_ENDPOINT =
  "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_ENDPOINT =
  "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_CALENDAR_API_ROOT =
  "https://www.googleapis.com/calendar/v3";

export const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.app.created";
export const GOOGLE_CALENDAR_SCOPES = [
  "openid",
  "email",
  GOOGLE_CALENDAR_SCOPE,
] as const;
export const GOOGLE_CALENDAR_NAME = "Gisela Lentz · Turnos";

export interface GoogleOAuthConfiguration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  appBaseUrl: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

export interface CalendarSyncAppointment {
  appointment_id: string;
  starts_at: string;
  ends_at: string;
  patient_name: string;
  timezone: string;
}

export interface GoogleCalendarEventPayload {
  id?: string;
  summary: string;
  description: string;
  visibility: "private";
  status: "confirmed";
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  extendedProperties: {
    private: { appointment_id: string; managed_by: string };
  };
}

export class GoogleIntegrationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(code);
    this.name = "GoogleIntegrationError";
    this.code = code;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
  }
}

function requiredValue(value: string | undefined, code: string): string {
  const clean = value?.trim();
  if (!clean) throw new GoogleIntegrationError(code, { status: 503 });
  return clean;
}

function normalizedHttpsUrl(
  value: string,
  code: string,
  allowLocalhost = false,
  rootOnly = false,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GoogleIntegrationError(code, { status: 503 });
  }
  const isLocal =
    allowLocalhost &&
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new GoogleIntegrationError(code, { status: 503 });
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (rootOnly && parsed.pathname !== "/")
  ) {
    throw new GoogleIntegrationError(code, { status: 503 });
  }
  return parsed.toString().replace(/\/$/, "");
}

export function googleOAuthConfiguration(
  env: (name: string) => string | undefined,
): GoogleOAuthConfiguration {
  return {
    clientId: requiredValue(
      env("GOOGLE_CALENDAR_CLIENT_ID"),
      "GOOGLE_CLIENT_ID_MISSING",
    ),
    clientSecret: requiredValue(
      env("GOOGLE_CALENDAR_CLIENT_SECRET"),
      "GOOGLE_CLIENT_SECRET_MISSING",
    ),
    redirectUri: normalizedHttpsUrl(
      requiredValue(
        env("GOOGLE_CALENDAR_REDIRECT_URI"),
        "GOOGLE_REDIRECT_URI_MISSING",
      ),
      "GOOGLE_REDIRECT_URI_INVALID",
      true,
    ),
    appBaseUrl: normalizedHttpsUrl(
      requiredValue(env("APP_BASE_URL"), "APP_BASE_URL_MISSING"),
      "APP_BASE_URL_INVALID",
      true,
      true,
    ),
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function randomBase64Url(byteLength = 32): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 96) {
    throw new GoogleIntegrationError("INVALID_RANDOM_LENGTH", { status: 500 });
  }
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function createPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = randomBase64Url(48);
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

export function buildGoogleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

export function appSettingsRedirect(
  appBaseUrl: string,
  result: "connected" | "denied" | "error",
): string {
  const url = new URL("/app/settings", `${appBaseUrl}/`);
  url.searchParams.set("section", "calendar");
  url.searchParams.set("google_calendar", result);
  return url.toString();
}

export function deterministicGoogleEventId(appointmentId: string): string {
  const hex = appointmentId.toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new GoogleIntegrationError("INVALID_APPOINTMENT_ID", { status: 400 });
  }
  return `gl${hex}`;
}

export function googleCalendarEventPayload(
  appointment: CalendarSyncAppointment,
  includeId = false,
): GoogleCalendarEventPayload {
  const start = new Date(appointment.starts_at);
  const end = new Date(appointment.ends_at);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start
  ) {
    throw new GoogleIntegrationError("INVALID_APPOINTMENT_RANGE", {
      status: 400,
    });
  }
  const patientName = appointment.patient_name.trim().replace(/\s+/g, " ");
  if (!patientName || patientName.length > 160) {
    throw new GoogleIntegrationError("INVALID_PATIENT_NAME", { status: 400 });
  }

  return {
    ...(includeId
      ? { id: deterministicGoogleEventId(appointment.appointment_id) }
      : {}),
    summary: `Turno odontológico · ${patientName}`,
    description: "Turno administrado desde la agenda de Gisela Lentz.",
    visibility: "private",
    status: "confirmed",
    start: {
      dateTime: start.toISOString(),
      timeZone: appointment.timezone,
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: appointment.timezone,
    },
    extendedProperties: {
      private: {
        appointment_id: appointment.appointment_id,
        managed_by: "gisela_lentz_agenda",
      },
    },
  };
}

export function retryDelaySeconds(attempts: number): number {
  const safeAttempts = Math.max(1, Math.min(Math.trunc(attempts), 10));
  return Math.min(6 * 60 * 60, 30 * 2 ** (safeAttempts - 1));
}

export function isRetryableGoogleStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function googleErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: string | { errors?: Array<{ reason?: string }>; status?: string };
    };
    if (typeof body.error === "string") return body.error;
    return body.error?.errors?.[0]?.reason ?? body.error?.status ?? null;
  } catch {
    return null;
  }
}

async function assertGoogleResponse(
  response: Response,
  fallbackCode: string,
): Promise<void> {
  if (response.ok) return;
  const remoteCode = await googleErrorCode(response);
  if (remoteCode === "invalid_grant") {
    throw new GoogleIntegrationError("GOOGLE_RECONNECT_REQUIRED", {
      status: 401,
    });
  }
  const rateLimited =
    response.status === 403 &&
    ["rateLimitExceeded", "userRateLimitExceeded"].includes(remoteCode ?? "");
  throw new GoogleIntegrationError(fallbackCode, {
    status: response.status,
    // Un 401 de Calendar no equivale a refresh token revocado. El worker
    // reintentará con un access token nuevo; sólo invalid_grant pide reconectar.
    retryable:
      response.status === 401 ||
      rateLimited ||
      isRetryableGoogleStatus(response.status),
  });
}

async function googleFetch(
  fetcher: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(15_000);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetcher(input, { ...init, signal });
  } catch {
    throw new GoogleIntegrationError("GOOGLE_NETWORK_FAILED", {
      status: 503,
      retryable: true,
    });
  }
}

async function parseJson<T>(response: Response, code: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new GoogleIntegrationError(code, {
      status: response.status,
      retryable: isRetryableGoogleStatus(response.status),
    });
  }
}

export async function exchangeGoogleAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  config: GoogleOAuthConfiguration;
  fetcher?: typeof fetch;
}): Promise<GoogleTokenResponse> {
  const fetcher = input.fetcher ?? fetch;
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.codeVerifier,
  });
  const response = await googleFetch(fetcher, GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  await assertGoogleResponse(response, "GOOGLE_TOKEN_EXCHANGE_FAILED");
  const result = await parseJson<GoogleTokenResponse>(
    response,
    "GOOGLE_TOKEN_RESPONSE_INVALID",
  );
  if (!result.access_token) {
    throw new GoogleIntegrationError("GOOGLE_ACCESS_TOKEN_MISSING", {
      status: 502,
    });
  }
  return result;
}

export async function refreshGoogleAccessToken(input: {
  refreshToken: string;
  config: GoogleOAuthConfiguration;
  fetcher?: typeof fetch;
}): Promise<GoogleTokenResponse> {
  const fetcher = input.fetcher ?? fetch;
  const response = await googleFetch(fetcher, GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  await assertGoogleResponse(response, "GOOGLE_TOKEN_REFRESH_FAILED");
  const result = await parseJson<GoogleTokenResponse>(
    response,
    "GOOGLE_TOKEN_RESPONSE_INVALID",
  );
  if (!result.access_token) {
    throw new GoogleIntegrationError("GOOGLE_ACCESS_TOKEN_MISSING", {
      status: 502,
    });
  }
  return result;
}

export async function fetchGoogleUserInfo(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleUserInfo> {
  const response = await googleFetch(fetcher, GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await assertGoogleResponse(response, "GOOGLE_USERINFO_FAILED");
  const user = await parseJson<GoogleUserInfo>(
    response,
    "GOOGLE_USERINFO_INVALID",
  );
  if (!user.sub || !user.email || user.email_verified !== true) {
    throw new GoogleIntegrationError("GOOGLE_VERIFIED_EMAIL_REQUIRED", {
      status: 409,
    });
  }
  return user;
}

export async function createManagedGoogleCalendar(input: {
  accessToken: string;
  timezone: string;
  fetcher?: typeof fetch;
}): Promise<{ id: string; summary?: string }> {
  const fetcher = input.fetcher ?? fetch;
  const response = await googleFetch(
    fetcher,
    `${GOOGLE_CALENDAR_API_ROOT}/calendars`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: GOOGLE_CALENDAR_NAME,
        description: "Turnos sincronizados desde la agenda de Gisela Lentz.",
        timeZone: input.timezone,
      }),
    },
  );
  await assertGoogleResponse(response, "GOOGLE_CALENDAR_CREATE_FAILED");
  const calendar = await parseJson<{ id?: string; summary?: string }>(
    response,
    "GOOGLE_CALENDAR_RESPONSE_INVALID",
  );
  if (!calendar.id) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_ID_MISSING", {
      status: 502,
    });
  }
  return { id: calendar.id, summary: calendar.summary };
}

export async function reuseOrCreateManagedGoogleCalendar(input: {
  accessToken: string;
  existingCalendarId?: string | null;
  timezone: string;
  fetcher?: typeof fetch;
}): Promise<{ id: string; summary?: string; reused: boolean }> {
  const fetcher = input.fetcher ?? fetch;
  const existingCalendarId = input.existingCalendarId?.trim();
  if (existingCalendarId) {
    const response = await googleFetch(
      fetcher,
      `${GOOGLE_CALENDAR_API_ROOT}/calendars/${encodeURIComponent(existingCalendarId)}`,
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
    );
    if (response.ok) {
      const calendar = await parseJson<{ id?: string; summary?: string }>(
        response,
        "GOOGLE_CALENDAR_RESPONSE_INVALID",
      );
      if (!calendar.id) {
        throw new GoogleIntegrationError("GOOGLE_CALENDAR_ID_MISSING", {
          status: 502,
        });
      }
      return { id: calendar.id, summary: calendar.summary, reused: true };
    }
    if (response.status === 403) {
      const reason = await googleErrorCode(response);
      if (
        ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason ?? "")
      ) {
        await assertGoogleResponse(response, "GOOGLE_CALENDAR_LOOKUP_FAILED");
      }
    } else if (response.status !== 404) {
      await assertGoogleResponse(response, "GOOGLE_CALENDAR_LOOKUP_FAILED");
    }
  }

  const calendar = await createManagedGoogleCalendar({
    accessToken: input.accessToken,
    timezone: input.timezone,
    fetcher,
  });
  return { ...calendar, reused: false };
}

function googleEventUrl(calendarId: string, eventId?: string): string {
  const root = `${GOOGLE_CALENDAR_API_ROOT}/calendars/${encodeURIComponent(calendarId)}/events`;
  const url = eventId ? `${root}/${encodeURIComponent(eventId)}` : root;
  return `${url}?sendUpdates=none`;
}

export async function upsertGoogleCalendarEvent(input: {
  accessToken: string;
  calendarId: string;
  appointment: CalendarSyncAppointment;
  fetcher?: typeof fetch;
}): Promise<{ eventId: string; operation: "inserted" | "patched" }> {
  const fetcher = input.fetcher ?? fetch;
  const eventId = deterministicGoogleEventId(input.appointment.appointment_id);
  const insertResponse = await googleFetch(
    fetcher,
    googleEventUrl(input.calendarId),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(googleCalendarEventPayload(input.appointment, true)),
    },
  );

  if (insertResponse.status === 404) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_RECONNECT_REQUIRED", {
      status: 404,
      retryable: true,
    });
  }

  if (insertResponse.status === 409) {
    const patchResponse = await googleFetch(
      fetcher,
      googleEventUrl(input.calendarId, eventId),
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(googleCalendarEventPayload(input.appointment)),
      },
    );
    if (patchResponse.status === 404 || patchResponse.status === 410) {
      // Google conserva tombstones de eventos eliminados. Un ID determinista
      // no se puede recrear inmediatamente; el worker conserva el job para
      // reintentar más tarde en vez de generar un duplicado con otro ID.
      throw new GoogleIntegrationError("GOOGLE_EVENT_TOMBSTONED", {
        status: patchResponse.status,
        retryable: true,
      });
    }
    await assertGoogleResponse(patchResponse, "GOOGLE_EVENT_PATCH_FAILED");
    return { eventId, operation: "patched" };
  }

  await assertGoogleResponse(insertResponse, "GOOGLE_EVENT_INSERT_FAILED");
  return { eventId, operation: "inserted" };
}

export async function deleteGoogleCalendarEvent(input: {
  accessToken: string;
  calendarId: string;
  appointmentId: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  const fetcher = input.fetcher ?? fetch;
  const eventId = deterministicGoogleEventId(input.appointmentId);
  const response = await googleFetch(
    fetcher,
    googleEventUrl(input.calendarId, eventId),
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (response.ok || response.status === 404 || response.status === 410) return;
  await assertGoogleResponse(response, "GOOGLE_EVENT_DELETE_FAILED");
}

export async function revokeGoogleToken(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await googleFetch(fetcher, GOOGLE_REVOCATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  // Un token ya vencido o revocado no impide limpiar la conexión local.
  if (response.ok || response.status === 400) return;
  await assertGoogleResponse(response, "GOOGLE_TOKEN_REVOCATION_FAILED");
}

export function safeGoogleErrorCode(error: unknown): string {
  if (error instanceof GoogleIntegrationError) return error.code;
  return "GOOGLE_SYNC_FAILED";
}

export function googleErrorRetryable(error: unknown): boolean {
  return error instanceof GoogleIntegrationError && error.retryable;
}
