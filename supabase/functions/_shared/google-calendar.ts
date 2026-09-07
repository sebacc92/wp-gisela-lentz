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
  patient_phone: string | null;
  is_existing_patient: boolean | null;
  coverage: "ioma" | "particular" | null;
  timezone: string;
}

export type GoogleCalendarProjectionStage = "pre_reservation" | "confirmed";

export interface GoogleCalendarManagedAssociation {
  eventId: string;
  automationEpoch: string;
  projectionStage: GoogleCalendarProjectionStage;
  projectedStage?: GoogleCalendarProjectionStage | "absent" | null;
}

export interface GoogleCalendarEventPayload {
  id?: string;
  summary: string;
  description: string;
  visibility: "private";
  status: "confirmed";
  reminders: { useDefault: false };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  extendedProperties: {
    private: {
      appointment_id: string;
      managed_by: string;
      automation_epoch: string;
      projection_stage: GoogleCalendarProjectionStage;
      payload_fingerprint: string;
    };
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

function managedGoogleCalendarFingerprintSource(input: {
  eventId: string;
  summary: string;
  description: string;
  visibility: string;
  status: string;
  remindersUseDefault: boolean;
  startsAt: string;
  startTimeZone: string;
  endsAt: string;
  endTimeZone: string;
  appointmentId: string;
  managedBy: string;
  automationEpoch: string;
  projectionStage: string;
}): string | null {
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (
    !input.eventId ||
    !input.summary ||
    !input.description ||
    !input.visibility ||
    !input.status ||
    !input.startTimeZone ||
    !input.endTimeZone ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start ||
    !APPOINTMENT_UUID_PATTERN.test(input.appointmentId) ||
    !APPOINTMENT_UUID_PATTERN.test(input.automationEpoch) ||
    !input.managedBy ||
    !["pre_reservation", "confirmed"].includes(input.projectionStage)
  ) {
    return null;
  }
  return JSON.stringify({
    version: 2,
    eventId: input.eventId,
    summary: input.summary,
    description: input.description,
    visibility: input.visibility,
    status: input.status,
    reminders: { useDefault: input.remindersUseDefault },
    start: {
      dateTime: start.toISOString(),
      timeZone: input.startTimeZone,
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: input.endTimeZone,
    },
    private: {
      appointment_id: input.appointmentId.toLowerCase(),
      managed_by: input.managedBy,
      automation_epoch: input.automationEpoch.toLowerCase(),
      projection_stage: input.projectionStage,
    },
  });
}

export async function googleCalendarEventPayload(
  appointment: CalendarSyncAppointment,
  association: GoogleCalendarManagedAssociation,
  includeId = false,
): Promise<GoogleCalendarEventPayload> {
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
  const eventId = boundedGoogleString(association.eventId, 1024);
  const automationEpoch = association.automationEpoch.trim().toLowerCase();
  if (!eventId) {
    throw new GoogleIntegrationError("GOOGLE_EVENT_ID_INVALID", {
      status: 400,
    });
  }
  if (!APPOINTMENT_UUID_PATTERN.test(automationEpoch)) {
    throw new GoogleIntegrationError("GOOGLE_AUTOMATION_EPOCH_INVALID", {
      status: 400,
    });
  }
  if (
    association.projectionStage !== "pre_reservation" &&
    association.projectionStage !== "confirmed"
  ) {
    throw new GoogleIntegrationError("GOOGLE_PROJECTION_STAGE_INVALID", {
      status: 400,
    });
  }

  const pending = association.projectionStage === "pre_reservation";
  const patientRecord =
    appointment.is_existing_patient === true
      ? "TF"
      : appointment.is_existing_patient === false
        ? "1ra vez"
        : "Ficha sin confirmar";
  const phone = appointment.patient_phone?.trim();
  const patientPhone =
    phone && /^\+[1-9][0-9]{7,14}$/.test(phone)
      ? phone
      : "Celular sin confirmar";
  const coverage =
    appointment.coverage === "ioma"
      ? "IOMA"
      : appointment.coverage === "particular"
        ? "Particular"
        : "Cobertura sin confirmar";
  const summary = [patientName, patientRecord, patientPhone, coverage];
  if (pending) summary.push("Pendiente de seña");

  const privateProperties = {
    appointment_id: appointment.appointment_id.toLowerCase(),
    managed_by: "gisela_lentz_agenda",
    automation_epoch: automationEpoch,
    projection_stage: association.projectionStage,
  };
  const payloadWithoutFingerprint = {
    ...(includeId ? { id: eventId } : {}),
    summary: summary.join(" · "),
    description: pending
      ? "Reserva pendiente administrada desde la agenda de Gisela Lentz."
      : "Turno confirmado administrado desde la agenda de Gisela Lentz.",
    visibility: "private" as const,
    status: "confirmed" as const,
    reminders: { useDefault: false as const },
    start: {
      dateTime: start.toISOString(),
      timeZone: appointment.timezone,
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: appointment.timezone,
    },
    extendedProperties: {
      private: privateProperties,
    },
  };
  const fingerprintSource = managedGoogleCalendarFingerprintSource({
    eventId,
    summary: payloadWithoutFingerprint.summary,
    description: payloadWithoutFingerprint.description,
    visibility: payloadWithoutFingerprint.visibility,
    status: payloadWithoutFingerprint.status,
    remindersUseDefault: payloadWithoutFingerprint.reminders.useDefault,
    startsAt: payloadWithoutFingerprint.start.dateTime,
    startTimeZone: payloadWithoutFingerprint.start.timeZone,
    endsAt: payloadWithoutFingerprint.end.dateTime,
    endTimeZone: payloadWithoutFingerprint.end.timeZone,
    appointmentId: privateProperties.appointment_id,
    managedBy: privateProperties.managed_by,
    automationEpoch: privateProperties.automation_epoch,
    projectionStage: privateProperties.projection_stage,
  });
  if (!fingerprintSource) {
    throw new GoogleIntegrationError("GOOGLE_EVENT_FINGERPRINT_INVALID", {
      status: 400,
    });
  }
  return {
    ...payloadWithoutFingerprint,
    extendedProperties: {
      private: {
        ...privateProperties,
        payload_fingerprint: await sha256Hex(fingerprintSource),
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
  association: GoogleCalendarManagedAssociation;
  beforeMutation: () => Promise<void>;
  etag?: string | null;
  fetcher?: typeof fetch;
}): Promise<{
  eventId: string;
  operation: "inserted" | "patched" | "adopted";
  etag: string | null;
}> {
  const fetcher = input.fetcher ?? fetch;
  const payload = await googleCalendarEventPayload(
    input.appointment,
    input.association,
    true,
  );
  const eventId = payload.id!;
  await input.beforeMutation();
  const insertResponse = await googleFetch(
    fetcher,
    googleEventUrl(input.calendarId),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  if (insertResponse.status === 404) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_RECONNECT_REQUIRED", {
      status: 404,
      retryable: true,
    });
  }

  if (insertResponse.status === 409) {
    const lookup = await getGoogleCalendarEvent({
      accessToken: input.accessToken,
      calendarId: input.calendarId,
      eventId,
      fetcher,
    });
    if (lookup.kind !== "found" || lookup.event.status === "cancelled") {
      throw new GoogleIntegrationError("GOOGLE_EVENT_TOMBSTONED", {
        status: lookup.kind === "missing" ? 404 : 410,
        retryable: true,
      });
    }
    assertManagedGoogleCalendarEventAssociation(
      lookup.event,
      input.appointment.appointment_id,
      input.association.automationEpoch,
    );
    const persistedEtag = input.etag?.trim() || null;
    const observedEtag = boundedGoogleString(lookup.event.etag, 255);
    const hasCompletedProjection =
      input.association.projectedStage === "pre_reservation" ||
      input.association.projectedStage === "confirmed";
    let patchEtag = persistedEtag;
    if (!persistedEtag || !hasCompletedProjection) {
      if (!(await managedGoogleCalendarEventFingerprintIsValid(lookup.event))) {
        throw new GoogleIntegrationError("GOOGLE_EVENT_OWNERSHIP_CONFLICT", {
          status: 409,
        });
      }
      if (await googleCalendarEventMatchesPayload(lookup.event, payload)) {
        return { eventId, operation: "adopted", etag: observedEtag };
      }
      if (!observedEtag) {
        throw new GoogleIntegrationError("GOOGLE_EVENT_PRECONDITION_FAILED", {
          status: 412,
          retryable: true,
        });
      }
      // Un POST anterior pudo llegar a Google aunque su respuesta se perdiera.
      // La huella demuestra que el remoto sigue exactamente como lo emitimos;
      // se adopta su ETag sólo para aplicar la versión actual reautorizada.
      patchEtag = observedEtag;
    } else if (!observedEtag || observedEtag !== persistedEtag) {
      // Un PATCH anterior pudo haberse aplicado aunque se perdiera su
      // respuesta. Sólo adoptamos el ETag nuevo cuando Google conserva
      // exactamente el payload deseado y su huella propia es válida; cualquier
      // edición humana o una versión administrada distinta sigue fallando por
      // precondición.
      if (
        observedEtag &&
        (await googleCalendarEventMatchesPayload(lookup.event, payload))
      ) {
        return { eventId, operation: "adopted", etag: observedEtag };
      }
      throw new GoogleIntegrationError("GOOGLE_EVENT_PRECONDITION_FAILED", {
        status: 412,
        retryable: true,
      });
    }
    if (!patchEtag) {
      throw new GoogleIntegrationError("GOOGLE_EVENT_PRECONDITION_FAILED", {
        status: 412,
        retryable: true,
      });
    }
    await input.beforeMutation();
    const patchResponse = await googleFetch(
      fetcher,
      googleEventUrl(input.calendarId, eventId),
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
          "If-Match": patchEtag,
        },
        body: JSON.stringify(
          await googleCalendarEventPayload(
            input.appointment,
            input.association,
          ),
        ),
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

export async function managedGoogleCalendarEventFingerprintIsValid(
  event: GoogleCalendarEvent,
): Promise<boolean> {
  const privateProperties = event.extendedProperties?.private ?? {};
  const sharedProperties = event.extendedProperties?.shared ?? {};
  const privateKeys = Object.keys(privateProperties).sort();
  const expectedKeys = [
    "appointment_id",
    "automation_epoch",
    "managed_by",
    "payload_fingerprint",
    "projection_stage",
  ];
  const reminderKeys = event.reminders
    ? Object.keys(event.reminders).sort()
    : [];
  const remindersAreDisabled =
    event.reminders !== undefined &&
    event.reminders !== null &&
    !Array.isArray(event.reminders) &&
    event.reminders.useDefault === false &&
    (event.reminders.overrides?.length ?? 0) === 0 &&
    reminderKeys.every((key) => key === "overrides" || key === "useDefault");
  if (
    privateKeys.length !== expectedKeys.length ||
    !privateKeys.every((key, index) => key === expectedKeys[index]) ||
    !/^[0-9a-f]{64}$/.test(privateProperties.payload_fingerprint ?? "") ||
    (event.transparency !== undefined && event.transparency !== "opaque") ||
    (event.attendees?.length ?? 0) !== 0 ||
    (event.recurrence?.length ?? 0) !== 0 ||
    Object.keys(sharedProperties).length !== 0 ||
    event.location !== undefined ||
    event.colorId !== undefined ||
    event.conferenceData !== undefined ||
    (event.attachments?.length ?? 0) !== 0 ||
    event.source !== undefined ||
    event.hangoutLink !== undefined ||
    (event.eventType !== undefined && event.eventType !== "default") ||
    !remindersAreDisabled
  ) {
    return false;
  }
  const source = managedGoogleCalendarFingerprintSource({
    eventId: event.id ?? "",
    summary: event.summary ?? "",
    description: event.description ?? "",
    visibility: event.visibility ?? "",
    status: event.status ?? "",
    remindersUseDefault: event.reminders?.useDefault === true,
    startsAt: event.start?.dateTime ?? "",
    startTimeZone: event.start?.timeZone ?? "",
    endsAt: event.end?.dateTime ?? "",
    endTimeZone: event.end?.timeZone ?? "",
    appointmentId: privateProperties.appointment_id ?? "",
    managedBy: privateProperties.managed_by ?? "",
    automationEpoch: privateProperties.automation_epoch ?? "",
    projectionStage: privateProperties.projection_stage ?? "",
  });
  return (
    source !== null &&
    (await sha256Hex(source)) === privateProperties.payload_fingerprint
  );
}

async function googleCalendarEventMatchesPayload(
  event: GoogleCalendarEvent,
  payload: GoogleCalendarEventPayload,
): Promise<boolean> {
  const remoteStart = event.start?.dateTime
    ? Date.parse(event.start.dateTime)
    : Number.NaN;
  const remoteEnd = event.end?.dateTime
    ? Date.parse(event.end.dateTime)
    : Number.NaN;
  const expectedStart = Date.parse(payload.start.dateTime);
  const expectedEnd = Date.parse(payload.end.dateTime);
  const remotePrivate = event.extendedProperties?.private ?? {};
  const expectedPrivate = payload.extendedProperties.private;
  const remotePrivateKeys = Object.keys(remotePrivate).sort();
  const expectedPrivateKeys = Object.keys(expectedPrivate).sort();
  // Sólo se omiten campos generados por Google (created, updated, htmlLink,
  // organizer, etc.). Todo el payload administrado debe volver idéntico;
  // invitados o recurrencia agregados manualmente impiden adoptar el evento.
  return (
    (await managedGoogleCalendarEventFingerprintIsValid(event)) &&
    event.id === payload.id &&
    event.summary === payload.summary &&
    event.description === payload.description &&
    event.visibility === payload.visibility &&
    event.status === payload.status &&
    event.reminders?.useDefault === payload.reminders.useDefault &&
    (event.reminders?.overrides?.length ?? 0) === 0 &&
    Number.isFinite(remoteStart) &&
    Number.isFinite(remoteEnd) &&
    remoteStart === expectedStart &&
    remoteEnd === expectedEnd &&
    event.start?.timeZone === payload.start.timeZone &&
    event.end?.timeZone === payload.end.timeZone &&
    (event.transparency === undefined || event.transparency === "opaque") &&
    (!event.attendees || event.attendees.length === 0) &&
    (!event.recurrence || event.recurrence.length === 0) &&
    remotePrivateKeys.length === expectedPrivateKeys.length &&
    remotePrivateKeys.every(
      (key, index) =>
        key === expectedPrivateKeys[index] &&
        remotePrivate[key] ===
          expectedPrivate[key as keyof typeof expectedPrivate],
    )
  );
}

function assertManagedGoogleCalendarEventAssociation(
  event: GoogleCalendarEvent,
  appointmentId: string,
  automationEpoch: string,
): void {
  const properties = event.extendedProperties?.private ?? {};
  if (
    properties.managed_by !== GOOGLE_MANAGED_BY ||
    properties.appointment_id?.trim().toLowerCase() !==
      appointmentId.trim().toLowerCase() ||
    properties.automation_epoch?.trim().toLowerCase() !==
      automationEpoch.trim().toLowerCase()
  ) {
    throw new GoogleIntegrationError("GOOGLE_EVENT_OWNERSHIP_CONFLICT", {
      status: 409,
    });
  }
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

export async function deleteManagedGoogleCalendarEvent(input: {
  accessToken: string;
  calendarId: string;
  eventId: string;
  appointmentId: string;
  automationEpoch: string;
  beforeMutation: () => Promise<void>;
  etag?: string | null;
  fetcher?: typeof fetch;
}): Promise<void> {
  const fetcher = input.fetcher ?? fetch;
  const lookup = await getGoogleCalendarEvent({
    accessToken: input.accessToken,
    calendarId: input.calendarId,
    eventId: input.eventId,
    fetcher,
  });
  if (lookup.kind !== "found" || lookup.event.status === "cancelled") return;
  assertManagedGoogleCalendarEventAssociation(
    lookup.event,
    input.appointmentId,
    input.automationEpoch,
  );
  const persistedEtag = input.etag?.trim() || null;
  const observedEtag = boundedGoogleString(lookup.event.etag, 255);
  let deleteEtag = persistedEtag;
  if (!observedEtag) {
    throw new GoogleIntegrationError("GOOGLE_EVENT_PRECONDITION_FAILED", {
      status: 412,
      retryable: true,
    });
  }
  if (!persistedEtag || persistedEtag !== observedEtag) {
    if (!(await managedGoogleCalendarEventFingerprintIsValid(lookup.event))) {
      if (persistedEtag) {
        throw new GoogleIntegrationError("GOOGLE_EVENT_PRECONDITION_FAILED", {
          status: 412,
          retryable: true,
        });
      }
      throw new GoogleIntegrationError("GOOGLE_EVENT_OWNERSHIP_CONFLICT", {
        status: 409,
      });
    }
    // Recuperación de un POST/PATCH confirmado por Google cuya respuesta local
    // se perdió. Sólo un payload propio autoconsistente permite adoptar el ETag.
    deleteEtag = observedEtag;
  }
  if (!deleteEtag) {
    throw new GoogleIntegrationError("GOOGLE_EVENT_PRECONDITION_FAILED", {
      status: 412,
      retryable: true,
    });
  }
  await input.beforeMutation();
  await deleteGoogleCalendarEventById({
    accessToken: input.accessToken,
    calendarId: input.calendarId,
    eventId: input.eventId,
    etag: deleteEtag,
    fetcher,
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
  description?: string;
  visibility?: string;
  etag?: string;
  updated?: string;
  transparency?: string;
  attendees?: unknown[];
  location?: unknown;
  colorId?: unknown;
  conferenceData?: unknown;
  attachments?: unknown[];
  reminders?: { useDefault?: unknown; overrides?: unknown[] };
  source?: unknown;
  hangoutLink?: unknown;
  eventType?: unknown;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleCalendarEventTime;
  endTimeUnspecified?: boolean;
  start?: GoogleCalendarEventTime;
  end?: GoogleCalendarEventTime;
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  };
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

const GOOGLE_RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const GOOGLE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const GOOGLE_LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;

function normalizedGoogleTimeZone(value: unknown): string | null {
  const timeZone = boundedGoogleString(value, 255);
  if (!timeZone) return null;
  try {
    // Construir el formatter valida nombres IANA y UTC sin depender de la
    // zona horaria del runtime que ejecuta la Function.
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return null;
  }
}

function calendarDateParts(
  instant: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value);
    const result = {
      year: value("year"),
      month: value("month"),
      day: value("day"),
      hour: value("hour"),
      minute: value("minute"),
      second: value("second"),
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Convierte una fecha `YYYY-MM-DD` de Calendar en la medianoche real de la
 * zona seleccionada. Es deliberadamente independiente de `TZ` del servidor y
 * devuelve null si esa fecha/medianoche no existe en la zona indicada.
 */
export function googleCalendarDateStart(
  date: string,
  timeZone: string,
): string | null {
  const match = GOOGLE_DATE_PATTERN.exec(date);
  const validTimeZone = normalizedGoogleTimeZone(timeZone);
  if (!match || !validTimeZone) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const expected = Date.UTC(year, month - 1, day);
  const expectedDate = new Date(expected);
  if (
    expectedDate.getUTCFullYear() !== year ||
    expectedDate.getUTCMonth() !== month - 1 ||
    expectedDate.getUTCDate() !== day
  ) {
    return null;
  }

  // Resolver el offset en el instante objetivo requiere iterar: el primer
  // estimado UTC puede caer a un lado distinto de una transición de DST.
  let candidate = expected;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = calendarDateParts(new Date(candidate), validTimeZone);
    if (!parts) return null;
    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const corrected = candidate + (expected - representedAsUtc);
    if (corrected === candidate) break;
    candidate = corrected;
  }

  const resolved = calendarDateParts(new Date(candidate), validTimeZone);
  if (
    !resolved ||
    resolved.year !== year ||
    resolved.month !== month ||
    resolved.day !== day ||
    resolved.hour !== 0 ||
    resolved.minute !== 0 ||
    resolved.second !== 0
  ) {
    return null;
  }
  return new Date(candidate).toISOString();
}

function googleCalendarLocalDateTime(
  value: string,
  timeZone: string,
): string | null {
  const match = GOOGLE_LOCAL_DATE_TIME_PATTERN.exec(value);
  const validTimeZone = normalizedGoogleTimeZone(timeZone);
  if (!match || !validTimeZone) return null;

  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const expected = Date.UTC(year, month - 1, day, hour, minute, second);
  const expectedDate = new Date(expected);
  if (
    expectedDate.getUTCFullYear() !== year ||
    expectedDate.getUTCMonth() !== month - 1 ||
    expectedDate.getUTCDate() !== day ||
    expectedDate.getUTCHours() !== hour ||
    expectedDate.getUTCMinutes() !== minute ||
    expectedDate.getUTCSeconds() !== second
  ) {
    return null;
  }

  // Un DateTime sin offset sólo es seguro si esa hora de pared corresponde a
  // un único instante. Muestrear ambos lados de la fecha detecta también el
  // pliegue y el hueco de los cambios DST sin elegir una ocurrencia a ciegas.
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sampled = expected + hours * 3_600_000;
    const parts = calendarDateParts(new Date(sampled), validTimeZone);
    if (!parts) return null;
    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    offsets.add(representedAsUtc - sampled);
  }

  const candidates = new Set<number>();
  for (const offset of offsets) {
    const candidate = expected - offset;
    const parts = calendarDateParts(new Date(candidate), validTimeZone);
    if (
      parts?.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === second
    ) {
      candidates.add(candidate);
    }
  }
  if (candidates.size !== 1) return null;

  const fractionMilliseconds = Number(
    (match[7] ?? "").slice(0, 3).padEnd(3, "0"),
  );
  return new Date([...candidates][0] + fractionMilliseconds).toISOString();
}

function isValidGoogleRfc3339(value: string): boolean {
  return (
    GOOGLE_RFC3339_PATTERN.test(value) &&
    googleCalendarDateStart(value.slice(0, 10), "UTC") !== null &&
    !Number.isNaN(Date.parse(value))
  );
}

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
  calendarTimeZone: string;
  syncToken?: string | null;
  timeMin?: string | null;
  timeMax?: string | null;
  pageToken?: string | null;
  maxResults?: number;
  fetcher?: typeof fetch;
}): Promise<GoogleCalendarEventsPage> {
  const fetcher = input.fetcher ?? fetch;
  const calendarTimeZone = normalizedGoogleTimeZone(input.calendarTimeZone);
  const timeMin = input.timeMin?.trim() || null;
  const timeMax = input.timeMax?.trim() || null;
  if (
    !calendarTimeZone ||
    (input.syncToken != null &&
      (input.timeMin != null || input.timeMax != null))
  ) {
    throw new GoogleIntegrationError("GOOGLE_EVENTS_LIST_PARAMETERS_INVALID", {
      status: 400,
    });
  }
  const validBound = (value: string | null): value is string =>
    Boolean(value && isValidGoogleRfc3339(value));
  if (
    (input.timeMin != null && !validBound(timeMin)) ||
    (input.timeMax != null && !validBound(timeMax)) ||
    (timeMin && timeMax && Date.parse(timeMax) <= Date.parse(timeMin))
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
  // Calendar expande cada serie dentro de la ventana. Así conserva IDs de
  // ocurrencia, excepciones movidas y tombstones de instancias canceladas sin
  // que la aplicación interprete RRULE por su cuenta.
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("showDeleted", "true");
  url.searchParams.set("timeZone", calendarTimeZone);
  if (input.syncToken) {
    url.searchParams.set("syncToken", input.syncToken);
  }
  if (timeMin) url.searchParams.set("timeMin", timeMin);
  if (timeMax) url.searchParams.set("timeMax", timeMax);
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
  const rawPage = await parseJson<unknown>(
    response,
    "GOOGLE_EVENTS_LIST_INVALID",
  );
  if (!rawPage || typeof rawPage !== "object" || Array.isArray(rawPage)) {
    throw new GoogleIntegrationError("GOOGLE_EVENTS_LIST_INVALID", {
      status: 502,
      retryable: true,
    });
  }
  const page = rawPage as {
    kind?: unknown;
    items?: unknown;
    nextPageToken?: unknown;
    nextSyncToken?: unknown;
    timeZone?: unknown;
    accessRole?: unknown;
  };
  const invalidItems =
    Array.isArray(page.items) &&
    page.items.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const id = (item as { id?: unknown }).id;
      return (
        typeof id !== "string" ||
        !id ||
        id !== id.trim() ||
        id.length > 1024 ||
        /[\u0000-\u001f\u007f]/.test(id)
      );
    });
  const validOpaqueToken = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  const hasNextPage = page.nextPageToken !== undefined;
  const hasNextSync = page.nextSyncToken !== undefined;

  if (
    (page.items !== undefined && !Array.isArray(page.items)) ||
    invalidItems ||
    (hasNextPage && !validOpaqueToken(page.nextPageToken)) ||
    (hasNextSync && !validOpaqueToken(page.nextSyncToken)) ||
    hasNextPage === hasNextSync
  ) {
    throw new GoogleIntegrationError("GOOGLE_EVENTS_LIST_INVALID", {
      status: 502,
      retryable: true,
    });
  }
  if (
    page.kind !== "calendar#events" ||
    normalizedGoogleTimeZone(page.timeZone) !== calendarTimeZone ||
    page.accessRole !== "owner"
  ) {
    throw new GoogleIntegrationError("GOOGLE_EVENTS_LIST_SCOPE_MISMATCH", {
      status: 409,
    });
  }

  return {
    items: (page.items ?? []) as GoogleCalendarEvent[],
    nextPageToken: hasNextPage ? (page.nextPageToken as string) : null,
    nextSyncToken: hasNextSync ? (page.nextSyncToken as string) : null,
  };
}

export type UnsupportedGoogleEventReason =
  | "ALL_DAY"
  | "RECURRING"
  | "AMBIGUOUS_BUSY_STATE"
  | "MISSING_RANGE"
  | "INVALID_RANGE";

export type ClassifiedGoogleEvent =
  | {
      kind: "managed";
      eventId: string;
      appointmentId: string;
      automationEpoch: string;
      projectionStage: GoogleCalendarProjectionStage;
      cancelled: boolean;
      startsAt: string | null;
      endsAt: string | null;
      updatedAt: string | null;
      etag: string | null;
    }
  | {
      kind: "managed_mismatch";
      eventId: string;
      reason: "APPOINTMENT_ID_MISMATCH";
    }
  | {
      kind: "managed_legacy";
      eventId: string;
      appointmentId: string;
      reason: "MISSING_CURRENT_AUTOMATION_MARKER";
    }
  | {
      kind: "external_block";
      eventId: string;
      summary: string | null;
      startsAt: string;
      endsAt: string;
      allDay: boolean;
      recurring: boolean;
      recurringEventId: string | null;
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
      removalReason: "cancelled" | "transparent";
      updatedAt: string | null;
      etag: string | null;
    }
  | { kind: "ignored"; eventId: string | null; reason: string };

export type ClassifiedExternalGoogleEvent = Exclude<
  ClassifiedGoogleEvent,
  | { kind: "managed" }
  | { kind: "managed_mismatch" }
  | { kind: "managed_legacy" }
>;

const APPOINTMENT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isoOrNull(
  value: string | undefined,
  timeZone?: string,
): string | null {
  if (!value) return null;
  const validTimeZone =
    timeZone === undefined ? null : normalizedGoogleTimeZone(timeZone);
  if (timeZone !== undefined && !validTimeZone) return null;
  if (isValidGoogleRfc3339(value)) return new Date(value).toISOString();
  return validTimeZone
    ? googleCalendarLocalDateTime(value, validTimeZone)
    : null;
}

/**
 * Sólo el marker completo del epoch actual puede proponerse como administrado.
 * Un prefijo determinista o marker legado se conserva como evento externo de
 * sólo lectura; el worker valida además su asociación exacta en la base.
 */
export function classifyGoogleCalendarEvent(
  event: GoogleCalendarEvent,
  calendarTimeZone?: string,
): ClassifiedGoogleEvent {
  const eventId = typeof event.id === "string" ? event.id.trim() : "";
  if (!eventId) return { kind: "ignored", eventId: null, reason: "NO_ID" };

  const properties = event.extendedProperties?.private ?? {};
  const declaredAppointmentId =
    properties.managed_by === GOOGLE_MANAGED_BY &&
    typeof properties.appointment_id === "string" &&
    APPOINTMENT_UUID_PATTERN.test(properties.appointment_id.trim())
      ? properties.appointment_id.trim().toLowerCase()
      : null;
  const automationEpoch =
    typeof properties.automation_epoch === "string" &&
    APPOINTMENT_UUID_PATTERN.test(properties.automation_epoch.trim())
      ? properties.automation_epoch.trim().toLowerCase()
      : null;
  const projectionStage =
    properties.projection_stage === "pre_reservation" ||
    properties.projection_stage === "confirmed"
      ? properties.projection_stage
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
  const cancelled = event.status === "cancelled";
  const updatedAt = isoOrNull(event.updated);
  const etag = boundedGoogleString(event.etag, 255);

  if (
    declaredAppointmentId &&
    automationEpoch &&
    projectionStage &&
    derivedAppointmentId &&
    declaredAppointmentId.toLowerCase() !== derivedAppointmentId
  ) {
    return {
      kind: "managed_mismatch",
      eventId,
      reason: "APPOINTMENT_ID_MISMATCH",
    };
  }

  if (declaredAppointmentId && automationEpoch && projectionStage) {
    return {
      kind: "managed",
      eventId,
      appointmentId: declaredAppointmentId,
      automationEpoch,
      projectionStage,
      cancelled,
      startsAt: isoOrNull(event.start?.dateTime, event.start?.timeZone),
      endsAt:
        event.endTimeUnspecified !== undefined &&
        event.endTimeUnspecified !== false
          ? null
          : isoOrNull(event.end?.dateTime, event.end?.timeZone),
      updatedAt,
      etag,
    };
  }

  const legacyAppointmentId = declaredAppointmentId ?? derivedAppointmentId;
  if (legacyAppointmentId) {
    return {
      kind: "managed_legacy",
      eventId,
      appointmentId: legacyAppointmentId,
      reason: "MISSING_CURRENT_AUTOMATION_MARKER",
    };
  }

  return classifyGoogleCalendarEventAsExternal(event, calendarTimeZone);
}

/**
 * Clasifica únicamente la forma externa del evento. Se usa como recuperación
 * cuando Google conserva marcadores de una integración anterior pero el turno
 * referenciado ya no existe en esta base. No cambia ni elimina esos marcadores:
 * sólo evita perder la ocupación remota al importarla como bloqueo (o como no
 * soportada) bajo el mismo lease de sincronización.
 */
export function classifyGoogleCalendarEventAsExternal(
  event: GoogleCalendarEvent,
  calendarTimeZone?: string,
): ClassifiedExternalGoogleEvent {
  const eventId = typeof event.id === "string" ? event.id.trim() : "";
  if (!eventId) return { kind: "ignored", eventId: null, reason: "NO_ID" };

  const cancelled = event.status === "cancelled";
  const updatedAt = isoOrNull(event.updated);
  const etag = boundedGoogleString(event.etag, 255);

  if (cancelled) {
    return {
      kind: "external_removed",
      eventId,
      removalReason: "cancelled",
      updatedAt,
      etag,
    };
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

  // Con `singleEvents=true` Google entrega instancias concretas. Una master
  // inesperada todavía requiere interpretación de RRULE y falla cerrada.
  if (Array.isArray(event.recurrence) && event.recurrence.length > 0) {
    return unsupported("RECURRING");
  }

  let recurringEventId: string | null = null;
  if (event.recurringEventId !== undefined) {
    recurringEventId = boundedGoogleString(event.recurringEventId, 1024);
    const original = event.originalStartTime;
    const originalHasDateTime = typeof original?.dateTime === "string";
    const originalHasDate = typeof original?.date === "string";
    const validOriginalDateTime =
      originalHasDateTime &&
      !originalHasDate &&
      isoOrNull(original.dateTime, original.timeZone) !== null;
    const validOriginalDate =
      originalHasDate &&
      !originalHasDateTime &&
      Boolean(
        calendarTimeZone &&
        googleCalendarDateStart(original.date ?? "", calendarTimeZone),
      );
    if (!recurringEventId || (!validOriginalDateTime && !validOriginalDate)) {
      return unsupported("RECURRING");
    }
  } else if (event.originalStartTime !== undefined) {
    // `originalStartTime` sólo identifica la posición original de una
    // instancia; sin recurringEventId no es una identidad utilizable.
    return unsupported("RECURRING");
  }

  if (event.transparency === "transparent") {
    return {
      kind: "external_removed",
      eventId,
      removalReason: "transparent",
      updatedAt,
      etag,
    };
  }
  if (event.transparency !== undefined && event.transparency !== "opaque") {
    return unsupported("AMBIGUOUS_BUSY_STATE");
  }
  if (
    event.endTimeUnspecified !== undefined &&
    event.endTimeUnspecified !== false
  ) {
    return unsupported("INVALID_RANGE");
  }

  const hasStartDate = typeof event.start?.date === "string";
  const hasEndDate = typeof event.end?.date === "string";
  const hasStartDateTime = typeof event.start?.dateTime === "string";
  const hasEndDateTime = typeof event.end?.dateTime === "string";
  const allDay = hasStartDate || hasEndDate;

  let startsAt: string | null;
  let endsAt: string | null;
  if (allDay) {
    if (
      !hasStartDate ||
      !hasEndDate ||
      hasStartDateTime ||
      hasEndDateTime ||
      !calendarTimeZone
    ) {
      return unsupported("INVALID_RANGE");
    }
    startsAt = googleCalendarDateStart(
      event.start?.date ?? "",
      calendarTimeZone,
    );
    endsAt = googleCalendarDateStart(event.end?.date ?? "", calendarTimeZone);
  } else {
    startsAt = isoOrNull(event.start?.dateTime, event.start?.timeZone);
    endsAt = isoOrNull(event.end?.dateTime, event.end?.timeZone);
  }

  if (!startsAt || !endsAt) return unsupported("MISSING_RANGE");
  if (new Date(endsAt) <= new Date(startsAt)) {
    return unsupported("INVALID_RANGE");
  }

  if (recurringEventId) {
    const original = event.originalStartTime;
    const originalIsAllDay = typeof original?.date === "string";
    if (originalIsAllDay !== allDay) return unsupported("RECURRING");
  }

  return {
    kind: "external_block",
    eventId,
    summary,
    startsAt,
    endsAt,
    allDay,
    recurring: recurringEventId !== null,
    recurringEventId,
    etag,
    updatedAt,
  };
}
