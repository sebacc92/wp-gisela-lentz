import { revokeGoogleToken } from "../_shared/google-calendar.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

interface DisconnectedSecrets {
  active_refresh_token?: unknown;
  candidate_refresh_token?: unknown;
}

export interface GoogleCalendarDisconnectDependencies {
  createClient?: () => SupabaseClient;
  authorize?: typeof authorizeUser;
  fetchImpl?: typeof fetch;
}

function firstRow(value: unknown): DisconnectedSecrets | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as DisconnectedSecrets)
    : null;
}

function refreshTokens(value: DisconnectedSecrets): {
  tokens: string[];
  allValuesValid: boolean;
} {
  const tokens = new Set<string>();
  let allValuesValid = true;
  for (const token of [
    value.active_refresh_token,
    value.candidate_refresh_token,
  ]) {
    if (token === null || token === undefined) continue;
    if (typeof token !== "string") {
      allValuesValid = false;
      continue;
    }
    const clean = token.trim();
    if (!clean || clean.length > 8192 || /[\r\n]/.test(clean)) {
      allValuesValid = false;
      continue;
    }
    tokens.add(clean);
  }
  return { tokens: [...tokens], allValuesValid };
}

export async function handleGoogleCalendarDisconnectRequest(
  request: Request,
  dependencies: GoogleCalendarDisconnectDependencies = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const client = (dependencies.createClient ?? createServiceClient)();
  try {
    const { user, profile } = await (dependencies.authorize ?? authorizeUser)(
      request,
      client,
    );
    if (profile.role !== "ADMIN") {
      return jsonResponse(request, { error: "ADMIN_REQUIRED" }, 403);
    }

    // Capturar ambas credenciales y limpiar conexión/candidato ocurre dentro de
    // una única transacción y los mismos advisory locks. Separarlo en dos RPCs
    // dejaría una carrera donde un callback podría crear un candidato huérfano.
    const { data, error: disconnectError } = await client.rpc(
      "disconnect_google_calendar_with_secrets",
      { p_user_id: user.id },
    );
    const disconnectedSecrets = firstRow(data);
    if (disconnectError || !disconnectedSecrets) {
      throw new Error("GOOGLE_DISCONNECT_FAILED");
    }

    const tokens = refreshTokens(disconnectedSecrets);
    const revocations = await Promise.allSettled(
      tokens.tokens.map((token) =>
        revokeGoogleToken(token, dependencies.fetchImpl ?? fetch),
      ),
    );
    const remoteRevocationConfirmed =
      tokens.allValuesValid &&
      revocations.every((result) => result.status === "fulfilled");

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
}

if (import.meta.main) {
  Deno.serve((request) => handleGoogleCalendarDisconnectRequest(request));
}
