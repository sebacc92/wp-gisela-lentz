import {
  assertOwnedGoogleCalendarEventsAccess,
  getOwnedGoogleCalendar,
  GoogleIntegrationError,
  googleOAuthConfiguration,
  listOwnedGoogleCalendars,
  refreshGoogleAccessToken,
} from "../_shared/google-calendar.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

interface ConnectionCandidate {
  candidate_id?: unknown;
  google_account_id?: unknown;
  google_account_email?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
}

interface ConnectionMetadata {
  status?: unknown;
  google_account_id?: unknown;
  google_calendar_id?: unknown;
}

class CalendarSelectionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "CalendarSelectionError";
    this.code = code;
    this.status = status;
  }
}

export interface GoogleCalendarSelectionDependencies {
  createClient?: () => SupabaseClient;
  authorize?: typeof authorizeUser;
  environment?: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function firstRow(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, maximum: number, code: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean.length > maximum) {
    throw new CalendarSelectionError(code, 409);
  }
  return clean;
}

function candidateFrom(
  value: unknown,
  now: number,
): {
  candidateId: string;
  googleAccountId: string;
  refreshToken: string;
} | null {
  const row = firstRow(value) as ConnectionCandidate | null;
  if (!row) return null;
  const candidateId = requiredString(
    row.candidate_id,
    64,
    "GOOGLE_CALENDAR_SELECTION_INVALID",
  );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidateId,
    )
  ) {
    throw new CalendarSelectionError("GOOGLE_CALENDAR_SELECTION_INVALID", 409);
  }
  const googleAccountId = requiredString(
    row.google_account_id,
    255,
    "GOOGLE_CALENDAR_SELECTION_INVALID",
  );
  requiredString(
    row.google_account_email,
    320,
    "GOOGLE_CALENDAR_SELECTION_INVALID",
  );
  const refreshToken = requiredString(
    row.refresh_token,
    8192,
    "GOOGLE_CALENDAR_SELECTION_INVALID",
  );
  const expiresAt = Date.parse(
    requiredString(row.expires_at, 64, "GOOGLE_CALENDAR_SELECTION_INVALID"),
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new CalendarSelectionError("GOOGLE_CALENDAR_SELECTION_EXPIRED", 409);
  }
  return { candidateId, googleAccountId, refreshToken };
}

async function loadCandidate(
  client: SupabaseClient,
  userId: string,
  now: number,
): Promise<{
  candidateId: string;
  googleAccountId: string;
  refreshToken: string;
} | null> {
  const { data, error } = await client.rpc(
    "get_google_calendar_connection_candidate_secret",
    { p_user_id: userId },
  );
  if (error) {
    throw new CalendarSelectionError(
      "GOOGLE_CALENDAR_SELECTION_UNAVAILABLE",
      500,
    );
  }
  return candidateFrom(data, now);
}

function finalizedGenerationIsValid(value: unknown): boolean {
  const generation = Array.isArray(value) ? value[0] : value;
  if (typeof generation === "number") {
    return Number.isSafeInteger(generation) && generation > 0;
  }
  if (typeof generation !== "string" || !/^[1-9]\d{0,18}$/.test(generation)) {
    return false;
  }
  return BigInt(generation) <= 9_223_372_036_854_775_807n;
}

async function parseSelectedCalendarId(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new CalendarSelectionError("INVALID_REQUEST", 400);
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new CalendarSelectionError("INVALID_REQUEST", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CalendarSelectionError("INVALID_REQUEST", 400);
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(input, "calendarId")
  ) {
    throw new CalendarSelectionError("INVALID_REQUEST", 400);
  }
  const calendarId =
    typeof input.calendarId === "string" ? input.calendarId.trim() : "";
  if (!calendarId || calendarId.length > 1024 || /[\r\n]/.test(calendarId)) {
    throw new CalendarSelectionError("INVALID_CALENDAR_ID", 400);
  }
  return calendarId;
}

async function alreadySelected(
  client: SupabaseClient,
  calendarId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc(
    "get_google_calendar_connection_metadata",
    {},
  );
  if (error) return false;
  const metadata = firstRow(data) as ConnectionMetadata | null;
  return (
    metadata?.status === "connected" &&
    metadata.google_calendar_id === calendarId
  );
}

async function accountChangeRequiresDisconnect(
  client: SupabaseClient,
  candidateAccountId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc(
    "get_google_calendar_connection_metadata",
    {},
  );
  if (error) {
    throw new CalendarSelectionError(
      "GOOGLE_CALENDAR_CONNECTION_UNAVAILABLE",
      500,
    );
  }
  const metadata = firstRow(data) as ConnectionMetadata | null;
  const currentAccountId =
    typeof metadata?.google_account_id === "string"
      ? metadata.google_account_id.trim()
      : "";
  return (
    (metadata?.status === "connected" ||
      metadata?.status === "reconnect_required") &&
    Boolean(currentAccountId) &&
    currentAccountId !== candidateAccountId
  );
}

function selectionErrorResponse(request: Request, error: unknown): Response {
  if (error instanceof CalendarSelectionError) {
    return jsonResponse(
      request,
      {
        error: error.code,
        message:
          error.status === 400
            ? "La selección no es válida."
            : error.code === "GOOGLE_CALENDAR_SELECTION_EXPIRED"
              ? "La selección venció. Volvé a conectar la cuenta."
              : error.code === "GOOGLE_CALENDAR_TIMEZONE_MISMATCH"
                ? "El calendario debe usar la zona horaria configurada en la agenda."
                : error.code === "GOOGLE_CALENDAR_DISCONNECT_REQUIRED"
                  ? "Desconectá la cuenta actual antes de elegir otra cuenta."
                  : "No pudimos completar la selección del calendario.",
      },
      error.status,
    );
  }
  if (error instanceof GoogleIntegrationError) {
    const status =
      error.code === "GOOGLE_RECONNECT_REQUIRED"
        ? 409
        : error.code === "GOOGLE_CALENDAR_OWNER_REQUIRED"
          ? 409
          : error.code === "GOOGLE_CALENDAR_EVENTS_ACCESS_REQUIRED"
            ? 409
            : error.status === 400
              ? 400
              : 502;
    return jsonResponse(
      request,
      {
        error: error.code,
        message:
          error.code === "GOOGLE_RECONNECT_REQUIRED"
            ? "Google pidió volver a conectar la cuenta."
            : error.code === "GOOGLE_CALENDAR_OWNER_REQUIRED"
              ? "Sólo podés elegir un calendario propio."
              : error.code === "GOOGLE_CALENDAR_EVENTS_ACCESS_REQUIRED"
                ? "Falta aceptar el permiso para administrar eventos de calendarios propios."
                : "No pudimos consultar Google Calendar.",
      },
      status,
    );
  }
  return jsonResponse(
    request,
    {
      error: "GOOGLE_CALENDAR_SELECTION_FAILED",
      message: "No pudimos completar la selección del calendario.",
    },
    500,
  );
}

export async function handleGoogleCalendarSelectionRequest(
  request: Request,
  dependencies: GoogleCalendarSelectionDependencies = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (
    request.method !== "GET" &&
    request.method !== "POST" &&
    request.method !== "DELETE"
  ) {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const client = (dependencies.createClient ?? createServiceClient)();
  try {
    const authorization = await (dependencies.authorize ?? authorizeUser)(
      request,
      client,
    );
    if (authorization.profile.role !== "ADMIN") {
      return jsonResponse(request, { error: "ADMIN_REQUIRED" }, 403);
    }

    if (request.method === "DELETE") {
      const { data, error } = await client.rpc(
        "cancel_google_calendar_connection_candidate",
        { p_user_id: authorization.user.id },
      );
      if (error || typeof data !== "boolean") {
        throw new CalendarSelectionError(
          "GOOGLE_CALENDAR_SELECTION_CANCEL_FAILED",
          500,
        );
      }
      return jsonResponse(request, {
        cancelled: true,
        alreadyCancelled: data === false,
      });
    }

    const calendarId =
      request.method === "POST" ? await parseSelectedCalendarId(request) : null;
    const candidate = await loadCandidate(
      client,
      authorization.user.id,
      (dependencies.now ?? Date.now)(),
    );
    if (!candidate) {
      if (calendarId && (await alreadySelected(client, calendarId))) {
        return jsonResponse(request, {
          connected: true,
          selected: true,
          alreadySelected: true,
        });
      }
      return request.method === "GET"
        ? jsonResponse(request, {
            selectionRequired: false,
            calendars: [],
          })
        : jsonResponse(
            request,
            {
              error: "GOOGLE_CALENDAR_SELECTION_NOT_PENDING",
              message: "Volvé a conectar la cuenta antes de elegir calendario.",
            },
            409,
          );
    }

    if (
      request.method === "POST" &&
      (await accountChangeRequiresDisconnect(client, candidate.googleAccountId))
    ) {
      throw new CalendarSelectionError(
        "GOOGLE_CALENDAR_DISCONNECT_REQUIRED",
        409,
      );
    }

    const config = googleOAuthConfiguration(
      dependencies.environment ?? ((name) => Deno.env.get(name)),
    );
    const tokens = await refreshGoogleAccessToken({
      refreshToken: candidate.refreshToken,
      config,
      fetcher: dependencies.fetchImpl,
    });

    if (request.method === "GET") {
      const calendars = await listOwnedGoogleCalendars({
        accessToken: tokens.access_token,
        fetcher: dependencies.fetchImpl,
      });
      return jsonResponse(request, {
        selectionRequired: true,
        calendars,
      });
    }

    const calendar = await getOwnedGoogleCalendar({
      accessToken: tokens.access_token,
      calendarId: calendarId as string,
      fetcher: dependencies.fetchImpl,
    });
    const { data: settings, error: settingsError } = await client
      .from("app_settings")
      .select("timezone")
      .eq("id", true)
      .single();
    const expectedTimeZone =
      typeof settings?.timezone === "string" ? settings.timezone.trim() : "";
    if (settingsError || !expectedTimeZone) {
      throw new CalendarSelectionError("APP_SETTINGS_NOT_FOUND", 503);
    }
    if (calendar.timeZone !== expectedTimeZone) {
      throw new CalendarSelectionError(
        "GOOGLE_CALENDAR_TIMEZONE_MISMATCH",
        409,
      );
    }
    await assertOwnedGoogleCalendarEventsAccess({
      accessToken: tokens.access_token,
      calendarId: calendar.id,
      fetcher: dependencies.fetchImpl,
    });

    const { data: finalizedGeneration, error: finalizeError } =
      await client.rpc("finalize_google_calendar_connection_selection", {
        p_user_id: authorization.user.id,
        p_candidate_id: candidate.candidateId,
        p_google_calendar_id: calendar.id,
        p_google_calendar_name: calendar.name,
        p_google_calendar_timezone: calendar.timeZone,
      });
    if (finalizeError || !finalizedGenerationIsValid(finalizedGeneration)) {
      throw new CalendarSelectionError(
        "GOOGLE_CALENDAR_SELECTION_FINALIZE_FAILED",
        409,
      );
    }
    return jsonResponse(request, {
      connected: true,
      selected: true,
      alreadySelected: false,
      calendarName: calendar.name,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
    }
    return selectionErrorResponse(request, error);
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleGoogleCalendarSelectionRequest(request));
}
