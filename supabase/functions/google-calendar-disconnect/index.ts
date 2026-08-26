import { revokeGoogleToken } from "../_shared/google-calendar.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";

interface CalendarSecret {
  refresh_token?: string;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const client = createServiceClient();
  try {
    const { user, profile } = await authorizeUser(request, client);
    if (profile.role !== "ADMIN") {
      return jsonResponse(request, { error: "ADMIN_REQUIRED" }, 403);
    }

    const { data, error: secretError } = await client.rpc(
      "get_google_calendar_connection_secret",
      {},
    );
    if (secretError) throw new Error("GOOGLE_CONNECTION_SECRET_UNAVAILABLE");
    const connection = (
      Array.isArray(data) ? data[0] : data
    ) as CalendarSecret | null;

    const { error: disconnectError } = await client.rpc(
      "disconnect_google_calendar",
      { p_user_id: user.id },
    );
    if (disconnectError) throw new Error("GOOGLE_DISCONNECT_FAILED");

    let remoteRevocationConfirmed = true;
    if (connection?.refresh_token) {
      try {
        await revokeGoogleToken(connection.refresh_token);
      } catch {
        // El deseo explícito de desconectar prevalece: nunca retenemos la
        // credencial local sólo porque Google esté temporalmente inaccesible.
        remoteRevocationConfirmed = false;
      }
    }

    return jsonResponse(request, {
      disconnected: true,
      eventsPreserved: true,
      remoteRevocationConfirmed,
      message: remoteRevocationConfirmed
        ? "Google Calendar fue desconectado. Los eventos que ya estaban en Google se conservaron."
        : "La conexión local fue eliminada. Si querés, también podés quitar el acceso desde tu cuenta de Google.",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
    }
    return jsonResponse(
      request,
      {
        error: "GOOGLE_DISCONNECT_FAILED",
        message: "No pudimos desconectar Google Calendar. Intentá nuevamente.",
      },
      502,
    );
  }
});
