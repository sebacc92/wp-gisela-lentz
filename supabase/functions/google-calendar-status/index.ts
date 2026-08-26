import { googleOAuthConfiguration } from "../_shared/google-calendar.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";

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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const client = createServiceClient();
  try {
    // El estado no incluye tokens, IDs internos ni secretos. Un OPERADOR puede
    // verlo en modo lectura para saber si la agenda se está sincronizando; las
    // acciones que cambian la conexión siguen reservadas al ADMIN.
    await authorizeUser(request, client);

    let configured = true;
    try {
      googleOAuthConfiguration((name) => Deno.env.get(name));
    } catch {
      configured = false;
    }

    const { data, error } = await client.rpc("google_calendar_status", {});
    if (error) throw new Error("GOOGLE_STATUS_UNAVAILABLE");
    const status = (
      Array.isArray(data) ? data[0] : data
    ) as CalendarStatus | null;
    const connected = configured && Boolean(status?.connected);
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
});
