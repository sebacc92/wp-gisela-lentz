import {
  appSettingsRedirect,
  exchangeGoogleAuthorizationCode,
  fetchGoogleUserInfo,
  GOOGLE_CALENDAR_NAME,
  googleOAuthConfiguration,
  reuseOrCreateManagedGoogleCalendar,
  revokeGoogleToken,
  sha256Hex,
} from "../_shared/google-calendar.ts";
import { createServiceClient } from "../_shared/supabase.ts";

interface ConsumedState {
  user_id: string;
  code_verifier: string;
}

interface ExistingConnection {
  google_calendar_id?: string | null;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

Deno.serve(async (request) => {
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let appBaseUrl: string;
  try {
    appBaseUrl = googleOAuthConfiguration((name) =>
      Deno.env.get(name),
    ).appBaseUrl;
  } catch {
    return new Response("Google Calendar no está configurado.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const errorRedirect = () =>
    redirect(appSettingsRedirect(appBaseUrl, "error"));
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim() ?? "";
  if (!state || state.length > 256) return errorRedirect();

  const client = createServiceClient();
  let refreshToken: string | undefined;
  let connectionStored = false;
  try {
    const stateHash = await sha256Hex(state);
    const { data, error: consumeError } = await client.rpc(
      "consume_google_calendar_oauth_state",
      { p_state_hash: stateHash },
    );
    const consumed = (
      Array.isArray(data) ? data[0] : data
    ) as ConsumedState | null;
    if (consumeError || !consumed?.user_id || !consumed.code_verifier) {
      return errorRedirect();
    }

    const providerError = url.searchParams.get("error");
    if (providerError) {
      return redirect(appSettingsRedirect(appBaseUrl, "denied"));
    }
    const issuer = url.searchParams.get("iss");
    if (
      issuer &&
      issuer !== "https://accounts.google.com" &&
      issuer !== "accounts.google.com"
    ) {
      return errorRedirect();
    }
    const code = url.searchParams.get("code")?.trim() ?? "";
    if (!code || code.length > 2048) return errorRedirect();

    const config = googleOAuthConfiguration((name) => Deno.env.get(name));
    const tokens = await exchangeGoogleAuthorizationCode({
      code,
      codeVerifier: consumed.code_verifier,
      config,
    });
    refreshToken = tokens.refresh_token;
    if (!refreshToken) throw new Error("GOOGLE_REFRESH_TOKEN_MISSING");

    const [googleUser, settingsResult] = await Promise.all([
      fetchGoogleUserInfo(tokens.access_token),
      client.from("app_settings").select("timezone").eq("id", true).single(),
    ]);
    if (settingsResult.error || !settingsResult.data?.timezone) {
      throw new Error("APP_SETTINGS_NOT_FOUND");
    }

    const { data: existingData, error: existingError } = await client.rpc(
      "get_google_calendar_connection_metadata",
      {},
    );
    if (existingError) throw new Error("GOOGLE_CONNECTION_LOOKUP_FAILED");
    const existingConnection = (
      Array.isArray(existingData) ? existingData[0] : existingData
    ) as ExistingConnection | null;

    const calendar = await reuseOrCreateManagedGoogleCalendar({
      accessToken: tokens.access_token,
      existingCalendarId: existingConnection?.google_calendar_id,
      timezone: settingsResult.data.timezone as string,
    });

    const { error: completeError } = await client.rpc(
      "complete_google_calendar_connection",
      {
        p_user_id: consumed.user_id,
        p_google_account_id: googleUser.sub,
        p_google_account_email: googleUser.email,
        p_google_calendar_id: calendar.id,
        p_google_calendar_name: calendar.summary ?? GOOGLE_CALENDAR_NAME,
        p_refresh_token: refreshToken,
      },
    );
    if (completeError) throw new Error("GOOGLE_CONNECTION_STORE_FAILED");
    connectionStored = true;

    return redirect(appSettingsRedirect(appBaseUrl, "connected"));
  } catch {
    if (refreshToken && !connectionStored) {
      try {
        await revokeGoogleToken(refreshToken);
      } catch {
        // La respuesta nunca incluye ni registra credenciales o errores crudos.
      }
    }
    return errorRedirect();
  }
});
