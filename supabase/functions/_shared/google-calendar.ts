export const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOCATION_ENDPOINT =
  "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_ENDPOINT =
  "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_CALENDAR_API_ROOT =
  "https://www.googleapis.com/calendar/v3";

export const GOOGLE_CALENDAR_LIST_SCOPE =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const GOOGLE_CALENDAR_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned";
export const GOOGLE_CALENDAR_SCOPES = [
  "openid",
  "email",
  GOOGLE_CALENDAR_LIST_SCOPE,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
] as const;

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

export interface OwnedGoogleCalendar {
  id: string;
  name: string;
  timeZone: string;
  primary: boolean;
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
  // No combinar silenciosamente scopes de una autorización anterior. En
  // particular, el grant legado `calendar.app.created` debe dejar de pedirse.
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

export function appSettingsRedirect(
  appBaseUrl: string,
  result: "connected" | "selection_required" | "denied" | "error",
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

interface GoogleCalendarListEntry {
  id?: unknown;
  summary?: unknown;
  summaryOverride?: unknown;
  timeZone?: unknown;
  primary?: unknown;
  accessRole?: unknown;
  deleted?: unknown;
}

interface GoogleCalendarListPage {
  items?: unknown;
  nextPageToken?: unknown;
}

function boundedGoogleString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= maximum && !/[\r\n]/.test(clean)
    ? clean
    : null;
}

function ownedGoogleCalendar(
  value: GoogleCalendarListEntry,
): OwnedGoogleCalendar | null {
  if (value.accessRole !== "owner" || value.deleted === true) return null;
  const id = boundedGoogleString(value.id, 1024);
  const name =
    boundedGoogleString(value.summaryOverride, 255) ??
    boundedGoogleString(value.summary, 255);
  const timeZone = boundedGoogleString(value.timeZone, 255);
  if (!id || !name || !timeZone) return null;
  return { id, name, timeZone, primary: value.primary === true };
}

/**
 * Devuelve únicamente calendarios que la cuenta conectada posee. Google sólo
 * documenta `minAccessRole=owner` para Workspace, por lo que cada item se
 * vuelve a filtrar localmente antes de exponerlo al administrador.
 */
export async function listOwnedGoogleCalendars(input: {
  accessToken: string;
  fetcher?: typeof fetch;
}): Promise<OwnedGoogleCalendar[]> {
  const fetcher = input.fetcher ?? fetch;
  const calendars = new Map<string, OwnedGoogleCalendar>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`${GOOGLE_CALENDAR_API_ROOT}/users/me/calendarList`);
    url.searchParams.set("minAccessRole", "owner");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("showHidden", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await googleFetch(fetcher, url, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    await assertGoogleResponse(response, "GOOGLE_CALENDAR_LIST_FAILED");
    const result = await parseJson<GoogleCalendarListPage>(
      response,
      "GOOGLE_CALENDAR_LIST_RESPONSE_INVALID",
    );
    const items = Array.isArray(result.items) ? result.items : [];
    for (const value of items) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const calendar = ownedGoogleCalendar(value as GoogleCalendarListEntry);
      if (calendar && !calendars.has(calendar.id)) {
        calendars.set(calendar.id, calendar);
      }
    }

    const nextPageToken = boundedGoogleString(result.nextPageToken, 2048);
    if (!nextPageToken) {
      pageToken = undefined;
      break;
    }
    if (seenPageTokens.has(nextPageToken)) {
      throw new GoogleIntegrationError(
        "GOOGLE_CALENDAR_LIST_RESPONSE_INVALID",
        {
          status: 502,
        },
      );
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  if (pageToken) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_LIST_TOO_LARGE", {
      status: 502,
    });
  }

  return [...calendars.values()].sort(
    (left, right) =>
      Number(right.primary) - Number(left.primary) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

/** Vuelve a consultar el item al confirmar; nunca confía sólo en el ID del UI. */
export async function getOwnedGoogleCalendar(input: {
  accessToken: string;
  calendarId: string;
  fetcher?: typeof fetch;
}): Promise<OwnedGoogleCalendar> {
  const calendarId = boundedGoogleString(input.calendarId, 1024);
  if (!calendarId) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_ID_INVALID", {
      status: 400,
    });
  }
  const fetcher = input.fetcher ?? fetch;
  const response = await googleFetch(
    fetcher,
    `${GOOGLE_CALENDAR_API_ROOT}/users/me/calendarList/${encodeURIComponent(
      calendarId,
    )}`,
    { headers: { Authorization: `Bearer ${input.accessToken}` } },
  );
  await assertGoogleResponse(response, "GOOGLE_CALENDAR_LOOKUP_FAILED");
  const value = await parseJson<GoogleCalendarListEntry>(
    response,
    "GOOGLE_CALENDAR_RESPONSE_INVALID",
  );
  const calendar = ownedGoogleCalendar(value);
  if (!calendar || calendar.id !== calendarId) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_OWNER_REQUIRED", {
      status: 409,
    });
  }
  return calendar;
}

/**
 * Prueba el permiso de eventos con una lectura mínima antes de activar la
 * conexión. CalendarList puede funcionar aunque el consentimiento granular
 * haya omitido `calendar.events.owned`.
 */
export async function assertOwnedGoogleCalendarEventsAccess(input: {
  accessToken: string;
  calendarId: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  const calendarId = boundedGoogleString(input.calendarId, 1024);
  if (!calendarId) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_ID_INVALID", {
      status: 400,
    });
  }
  const url = new URL(
    `${GOOGLE_CALENDAR_API_ROOT}/calendars/${encodeURIComponent(
      calendarId,
    )}/events`,
  );
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("showDeleted", "false");
  const response = await googleFetch(input.fetcher ?? fetch, url, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  await assertGoogleResponse(
    response,
    "GOOGLE_CALENDAR_EVENTS_ACCESS_REQUIRED",
  );
  await parseJson<Record<string, unknown>>(
    response,
    "GOOGLE_CALENDAR_RESPONSE_INVALID",
  );
}

function googleEventUrl(calendarId: string, eventId?: string): string {
  const root = `${GOOGLE_CALENDAR_API_ROOT}/calendars/${encodeURIComponent(
    calendarId,
  )}/events`;
  const url = eventId ? `${root}/${encodeURIComponent(eventId)}` : root;
  return `${url}?sendUpdates=none`;
}

/** Un 412 significa que el evento cambió después de que lo leímos. Nunca se
 * fuerza la escritura: el job se reintenta y el próximo pull incremental
 * reporta ese cambio, que se convierte en un conflicto para revisión. */
function assertPreconditionHeld(response: Response): void {
  if (response.status !== 412) return;
  throw new GoogleIntegrationError("GOOGLE_EVENT_PRECONDITION_FAILED", {
    status: 412,
    retryable: true,
  });
}

async function eventEtag(response: Response): Promise<string | null> {
  const header = response.headers.get("etag");
  if (header) return header.slice(0, 255);
  try {
    const body = (await response.clone().json()) as { etag?: unknown };
    return typeof body.etag === "string" ? body.etag.slice(0, 255) : null;
  } catch {
    return null;
  }
}

export async function upsertGoogleCalendarEvent(input: {
  accessToken: string;
  calendarId: string;
  appointment: CalendarSyncAppointment;
  etag?: string | null;
  fetcher?: typeof fetch;
}): Promise<{
  eventId: string;
  operation: "inserted" | "patched";
  etag: string | null;
}> {
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
    const conditionalEtag = input.etag?.trim();
    const patchResponse = await googleFetch(
      fetcher,
      googleEventUrl(input.calendarId, eventId),
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
          ...(conditionalEtag ? { "If-Match": conditionalEtag } : {}),
        },
        body: JSON.stringify(googleCalendarEventPayload(input.appointment)),
      },
    );
    assertPreconditionHeld(patchResponse);
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
    return {
      eventId,
      operation: "patched",
      etag: await eventEtag(patchResponse),
    };
  }

  await assertGoogleResponse(insertResponse, "GOOGLE_EVENT_INSERT_FAILED");
  return {
    eventId,
    operation: "inserted",
    etag: await eventEtag(insertResponse),
  };
}

export async function deleteGoogleCalendarEventById(input: {
  accessToken: string;
  calendarId: string;
  eventId: string;
  etag?: string | null;
  fetcher?: typeof fetch;
}): Promise<void> {
  const fetcher = input.fetcher ?? fetch;
  const conditionalEtag = input.etag?.trim();
  const response = await googleFetch(
    fetcher,
    googleEventUrl(input.calendarId, input.eventId),
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        ...(conditionalEtag ? { "If-Match": conditionalEtag } : {}),
      },
    },
  );
  assertPreconditionHeld(response);
  if (response.ok || response.status === 404 || response.status === 410) return;
  await assertGoogleResponse(response, "GOOGLE_EVENT_DELETE_FAILED");
}

export async function deleteGoogleCalendarEvent(input: {
  accessToken: string;
  calendarId: string;
  appointmentId: string;
  etag?: string | null;
  fetcher?: typeof fetch;
}): Promise<void> {
  await deleteGoogleCalendarEventById({
    accessToken: input.accessToken,
    calendarId: input.calendarId,
    eventId: deterministicGoogleEventId(input.appointmentId),
    etag: input.etag,
    fetcher: input.fetcher,
  });
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

// ---------------------------------------------------------------------------
// Lectura incremental del calendario seleccionado (Google -> App)
// ---------------------------------------------------------------------------
//
// `calendar.events.owned` habilita lectura/escritura de eventos únicamente en
// calendarios propios. `calendar.calendarlist.readonly` permite seleccionar uno
// preexistente; `openid email` siguen siendo los únicos scopes de identidad. Se
// usa el sync token oficial: la primera corrida pagina hasta obtener
// `nextSyncToken` y las siguientes envían `syncToken`.

export const GOOGLE_MANAGED_BY = "gisela_lentz_agenda";

export interface GoogleCalendarEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleCalendarEvent {
  id?: string;
  status?: string;
  summary?: string;
  etag?: string;
  updated?: string;
  recurrence?: string[];
  recurringEventId?: string;
  start?: GoogleCalendarEventTime;
  end?: GoogleCalendarEventTime;
  extendedProperties?: { private?: Record<string, string> };
}

export interface GoogleCalendarEventsPage {
  items: GoogleCalendarEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export type GoogleCalendarEventLookupResult =
  | { kind: "found"; event: GoogleCalendarEvent }
  | { kind: "missing" }
  | { kind: "tombstone" };

/**
 * Consulta puntual usada para cerrar los huecos de un full resync acotado a
 * futuro. Un 404 y un tombstone 410 son estados esperables y distinguibles;
 * cualquier otro fallo conserva únicamente un código local saneado.
 */
export async function getGoogleCalendarEvent(input: {
  accessToken: string;
  calendarId: string;
  eventId: string;
  fetcher?: typeof fetch;
}): Promise<GoogleCalendarEventLookupResult> {
  const calendarId = boundedGoogleString(input.calendarId, 1024);
  const eventId = boundedGoogleString(input.eventId, 1024);
  if (!calendarId) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_ID_INVALID", {
      status: 400,
    });
  }
  if (!eventId) {
    throw new GoogleIntegrationError("GOOGLE_EVENT_ID_INVALID", {
      status: 400,
    });
  }

  const response = await googleFetch(
    input.fetcher ?? fetch,
    `${GOOGLE_CALENDAR_API_ROOT}/calendars/${encodeURIComponent(
      calendarId,
    )}/events/${encodeURIComponent(eventId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (response.status === 404) return { kind: "missing" };
  if (response.status === 410) return { kind: "tombstone" };
  if (response.status !== 200) {
    await assertGoogleResponse(response, "GOOGLE_EVENT_GET_FAILED");
    throw new GoogleIntegrationError("GOOGLE_EVENT_GET_RESPONSE_INVALID", {
      status: 502,
    });
  }

  const value = await parseJson<unknown>(
    response,
    "GOOGLE_EVENT_GET_RESPONSE_INVALID",
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoogleIntegrationError("GOOGLE_EVENT_GET_RESPONSE_INVALID", {
      status: 502,
    });
  }
  const event = value as GoogleCalendarEvent;
  if (boundedGoogleString(event.id, 1024) !== eventId) {
    throw new GoogleIntegrationError("GOOGLE_EVENT_GET_RESPONSE_INVALID", {
      status: 502,
    });
  }
  return { kind: "found", event };
}

export async function listGoogleCalendarEvents(input: {
  accessToken: string;
  calendarId: string;
  syncToken?: string | null;
  timeMin?: string | null;
  pageToken?: string | null;
  maxResults?: number;
  fetcher?: typeof fetch;
}): Promise<GoogleCalendarEventsPage> {
  const fetcher = input.fetcher ?? fetch;
  const timeMin = input.timeMin?.trim() || null;
  if (timeMin && input.syncToken) {
    throw new GoogleIntegrationError("GOOGLE_EVENTS_LIST_PARAMETERS_INVALID", {
      status: 400,
    });
  }
  if (
    input.timeMin != null &&
    (!timeMin ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        timeMin,
      ) ||
      Number.isNaN(Date.parse(timeMin)))
  ) {
    throw new GoogleIntegrationError("GOOGLE_EVENTS_LIST_PARAMETERS_INVALID", {
      status: 400,
    });
  }
  const url = new URL(
    `${GOOGLE_CALENDAR_API_ROOT}/calendars/${encodeURIComponent(
      input.calendarId,
    )}/events`,
  );
  url.searchParams.set(
    "maxResults",
    String(Math.max(1, Math.min(input.maxResults ?? 250, 2500))),
  );
  // Sin `singleEvents`: una serie recurrente se reporta como no soportada en
  // vez de expandirse en instancias inventadas.
  url.searchParams.set("showDeleted", "true");
  if (input.syncToken) {
    url.searchParams.set("syncToken", input.syncToken);
  }
  if (timeMin) url.searchParams.set("timeMin", timeMin);
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);

  const response = await googleFetch(fetcher, url.toString(), {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });

  if (response.status === 410) {
    // El sync token caducó. Quien llama debe reintentar sin token.
    throw new GoogleIntegrationError("GOOGLE_SYNC_TOKEN_EXPIRED", {
      status: 410,
      retryable: false,
    });
  }
  if (response.status === 404) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_RECONNECT_REQUIRED", {
      status: 404,
      retryable: true,
    });
  }
  await assertGoogleResponse(response, "GOOGLE_EVENTS_LIST_FAILED");
  const page = await parseJson<{
    items?: unknown;
    nextPageToken?: unknown;
    nextSyncToken?: unknown;
  }>(response, "GOOGLE_EVENTS_LIST_INVALID");

  return {
    items: Array.isArray(page.items)
      ? (page.items as GoogleCalendarEvent[])
      : [],
    nextPageToken:
      typeof page.nextPageToken === "string" && page.nextPageToken
        ? page.nextPageToken
        : null,
    nextSyncToken:
      typeof page.nextSyncToken === "string" && page.nextSyncToken
        ? page.nextSyncToken
        : null,
  };
}

export type UnsupportedGoogleEventReason =
  | "ALL_DAY"
  | "RECURRING"
  | "MISSING_RANGE"
  | "INVALID_RANGE";

export type ClassifiedGoogleEvent =
  | {
      kind: "managed";
      eventId: string;
      appointmentId: string;
      cancelled: boolean;
      startsAt: string | null;
      endsAt: string | null;
      updatedAt: string | null;
      etag: string | null;
    }
  | {
      kind: "external_block";
      eventId: string;
      summary: string | null;
      startsAt: string;
      endsAt: string;
      etag: string | null;
      updatedAt: string | null;
    }
  | {
      kind: "external_unsupported";
      eventId: string;
      reason: UnsupportedGoogleEventReason;
      summary: string | null;
      etag: string | null;
      updatedAt: string | null;
    }
  | {
      kind: "external_removed";
      eventId: string;
      updatedAt: string | null;
      etag: string | null;
    }
  | { kind: "ignored"; eventId: string | null; reason: string };

const APPOINTMENT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Distingue lo que administra la aplicación de lo que alguien creó a mano.
 * `extendedProperties.private` es la señal primaria; el id determinista actúa
 * de respaldo por si alguien editó las propiedades en Google.
 */
export function classifyGoogleCalendarEvent(
  event: GoogleCalendarEvent,
): ClassifiedGoogleEvent {
  const eventId = typeof event.id === "string" ? event.id.trim() : "";
  if (!eventId) return { kind: "ignored", eventId: null, reason: "NO_ID" };

  const properties = event.extendedProperties?.private ?? {};
  const declaredAppointmentId =
    properties.managed_by === GOOGLE_MANAGED_BY &&
    typeof properties.appointment_id === "string" &&
    APPOINTMENT_UUID_PATTERN.test(properties.appointment_id.trim())
      ? properties.appointment_id.trim()
      : null;
  const deterministicMatch = /^gl([0-9a-f]{32})$/.exec(eventId);
  const derivedAppointmentId = deterministicMatch
    ? [
        deterministicMatch[1].slice(0, 8),
        deterministicMatch[1].slice(8, 12),
        deterministicMatch[1].slice(12, 16),
        deterministicMatch[1].slice(16, 20),
        deterministicMatch[1].slice(20),
      ].join("-")
    : null;
  const appointmentId = declaredAppointmentId ?? derivedAppointmentId;
  const cancelled = event.status === "cancelled";
  const updatedAt = isoOrNull(event.updated);
  const etag = boundedGoogleString(event.etag, 255);

  if (appointmentId) {
    return {
      kind: "managed",
      eventId,
      appointmentId,
      cancelled,
      startsAt: isoOrNull(event.start?.dateTime),
      endsAt: isoOrNull(event.end?.dateTime),
      updatedAt,
      etag,
    };
  }

  if (cancelled) {
    return { kind: "external_removed", eventId, updatedAt, etag };
  }

  const summary =
    typeof event.summary === "string" && event.summary.trim()
      ? event.summary.trim().slice(0, 120)
      : null;
  const unsupported = (reason: UnsupportedGoogleEventReason) =>
    ({
      kind: "external_unsupported",
      eventId,
      reason,
      summary,
      etag,
      updatedAt,
    }) as const;

  if (
    (Array.isArray(event.recurrence) && event.recurrence.length > 0) ||
    typeof event.recurringEventId === "string"
  ) {
    return unsupported("RECURRING");
  }
  if (event.start?.date || event.end?.date) return unsupported("ALL_DAY");

  const startsAt = isoOrNull(event.start?.dateTime);
  const endsAt = isoOrNull(event.end?.dateTime);
  if (!startsAt || !endsAt) return unsupported("MISSING_RANGE");
  if (new Date(endsAt) <= new Date(startsAt)) {
    return unsupported("INVALID_RANGE");
  }

  return {
    kind: "external_block",
    eventId,
    summary,
    startsAt,
    endsAt,
    etag,
    updatedAt,
  };
}
