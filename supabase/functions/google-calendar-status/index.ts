import { googleOAuthConfiguration } from "../_shared/google-calendar.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

interface CalendarStatus {
  connected?: boolean;
  status?: string;
  google_account_email?: string | null;
  google_calendar_name?: string | null;
  last_synced_at?: string | null;
  last_error?: string | null;
  pending_count?: number | string | null;
  failed_count?: number | string | null;
}

type CalendarConnectionState =
  | "connected"
  | "disconnected"
  | "reconnect_required"
  | "pending"
  | "error"
  | "incomplete";

export interface GoogleCalendarStatusDependencies {
  createClient?: () => SupabaseClient;
  authorize?: typeof authorizeUser;
  environment?: (name: string) => string | undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function calendarConnectionState(
  value: unknown,
): CalendarConnectionState | null {
  return value === "connected" ||
    value === "disconnected" ||
    value === "reconnect_required" ||
    value === "pending" ||
    value === "error"
    ? value
    : null;
}

async function asksForManualProjection(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return false;
  try {
    return record(await request.json())?.action === "manual_status";
  } catch {
    return false;
  }
}

export async function handleGoogleCalendarStatusRequest(
  request: Request,
  dependencies: GoogleCalendarStatusDependencies = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const manualProjection = await asksForManualProjection(request);
  const client = (dependencies.createClient ?? createServiceClient)();
  try {
    // The regular Settings view may show the connected Calendar name and email
    // to an authenticated user. The Manual asks for a separate, ADMIN-only
    // projection with only operational booleans/counts.
    const authorization = await (dependencies.authorize ?? authorizeUser)(
      request,
      client,
    );
    if (manualProjection && authorization.profile.role !== "ADMIN") {
      return jsonResponse(request, { error: "ADMIN_REQUIRED" }, 403);
    }

    let configured = true;
    try {
      googleOAuthConfiguration(
        dependencies.environment ?? ((name) => Deno.env.get(name)),
      );
    } catch {
      configured = false;
    }

    const { data, error } = await client.rpc("google_calendar_status", {});
    if (error) throw new Error("GOOGLE_STATUS_UNAVAILABLE");
    const status = (
      Array.isArray(data) ? data[0] : data
    ) as CalendarStatus | null;
    const rawConnected =
      typeof status?.connected === "boolean" ? status.connected : null;
    const rawPendingCount = nonNegativeSafeInteger(status?.pending_count);
    const rawFailedCount = nonNegativeSafeInteger(status?.failed_count);
    const explicitState = calendarConnectionState(status?.status);
    const manualState: CalendarConnectionState | null = !configured
      ? "incomplete"
      : typeof status?.status === "string"
        ? explicitState
        : rawConnected === true
          ? "connected"
          : rawConnected === false
            ? "disconnected"
            : null;

    if (manualProjection) {
      return jsonResponse(request, {
        configured,
        connected: configured ? rawConnected : false,
        status: manualState,
        pendingCount: rawPendingCount,
        failedCount: rawFailedCount,
      });
    }

    // Backwards-compatible response used by the existing Calendar Settings UI.
    const connected = configured && rawConnected === true;
    const pendingCount = Number(status?.pending_count ?? 0);
    const failedCount = Number(status?.failed_count ?? 0);
    const connectionState = !configured
      ? "incomplete"
      : (status?.status ?? (connected ? "connected" : "disconnected"));
    const state =
      connectionState === "connected" && failedCount > 0
        ? "error"
        : connectionState === "connected" && pendingCount > 0
          ? "pending"
          : connectionState;

    return jsonResponse(request, {
      configured,
      connected,
      status: state,
      email: status?.google_account_email ?? null,
      calendarName: status?.google_calendar_name ?? null,
      lastSyncedAt: status?.last_synced_at ?? null,
      pendingCount,
      failedCount,
      message: !configured
        ? "Falta configurar Google Calendar en el servidor."
        : connectionState === "reconnect_required"
          ? "Google pidió volver a conectar la cuenta."
          : connected
            ? "Los turnos se sincronizan automáticamente."
            : "Google Calendar todavía no está conectado.",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
    }
    return jsonResponse(
      request,
      {
        error: "GOOGLE_STATUS_UNAVAILABLE",
        message: "No pudimos consultar Google Calendar.",
      },
      500,
    );
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleGoogleCalendarStatusRequest(request));
}
