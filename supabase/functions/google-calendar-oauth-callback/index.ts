import {
  appSettingsRedirect,
  exchangeGoogleAuthorizationCode,
  fetchGoogleUserInfo,
  type GoogleOAuthConfiguration,
  googleOAuthConfiguration,
  sha256Hex,
} from "../_shared/google-calendar.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

interface ConsumedState {
  user_id: string;
  code_verifier: string;
  connection_generation: number | string;
  oauth_attempt_generation: number | string;
}

interface StagedCandidate {
  candidate_id?: unknown;
  expires_at?: unknown;
}

export interface GoogleCalendarOAuthCallbackDependencies {
  createClient?: () => SupabaseClient;
  environment?: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

function validGeneration(value: unknown, allowZero: boolean): boolean {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,18})$/.test(value)) {
    return false;
  }
  const parsed = BigInt(value);
  return (
    parsed <= 9_223_372_036_854_775_807n &&
    (allowZero ? parsed >= 0n : parsed > 0n)
  );
}

function stagedCandidateIsValid(value: unknown): boolean {
  const row = (
    Array.isArray(value) ? value[0] : value
  ) as StagedCandidate | null;
  if (!row || typeof row !== "object") return false;
  const candidateId =
    typeof row.candidate_id === "string" ? row.candidate_id.trim() : "";
  const expiresAt =
    typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidateId,
    ) &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now()
  );
}

export async function handleGoogleCalendarOAuthCallbackRequest(
  request: Request,
  dependencies: GoogleCalendarOAuthCallbackDependencies = {},
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const environment =
    dependencies.environment ?? ((name: string) => Deno.env.get(name));
  let config: GoogleOAuthConfiguration;
  try {
    config = googleOAuthConfiguration(environment);
  } catch {
    return new Response("Google Calendar no está configurado.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const errorRedirect = () =>
    redirect(appSettingsRedirect(config.appBaseUrl, "error"));
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim() ?? "";
  if (!state || state.length > 256) return errorRedirect();

  const client = (dependencies.createClient ?? createServiceClient)();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const stateHash = await sha256Hex(state);
    const { data, error: consumeError } = await client.rpc(
      "consume_google_calendar_oauth_state",
      { p_state_hash: stateHash },
    );
    const consumed = (
      Array.isArray(data) ? data[0] : data
    ) as ConsumedState | null;
    if (
      consumeError ||
      !consumed?.user_id ||
      !consumed.code_verifier ||
      !validGeneration(consumed.connection_generation, true) ||
      !validGeneration(consumed.oauth_attempt_generation, false)
    ) {
      return errorRedirect();
    }

    const providerError = url.searchParams.get("error");
    if (providerError) {
      return redirect(appSettingsRedirect(config.appBaseUrl, "denied"));
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

    const tokens = await exchangeGoogleAuthorizationCode({
      code,
      codeVerifier: consumed.code_verifier,
      config,
      fetcher: fetchImpl,
    });
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) throw new Error("GOOGLE_REFRESH_TOKEN_MISSING");

    const googleUser = await fetchGoogleUserInfo(
      tokens.access_token,
      fetchImpl,
    );
    const { data: stagedData, error: stageError } = await client.rpc(
      "stage_google_calendar_connection_candidate",
      {
        p_user_id: consumed.user_id,
        p_google_account_id: googleUser.sub,
        p_google_account_email: googleUser.email,
        p_refresh_token: refreshToken,
        p_expected_connection_generation: consumed.connection_generation,
        p_expected_oauth_attempt_generation: consumed.oauth_attempt_generation,
      },
    );
    if (stageError || !stagedCandidateIsValid(stagedData)) {
      throw new Error("GOOGLE_CONNECTION_STAGE_FAILED");
    }

    // No se revoca el token ante un fallo posterior: Google puede invalidar
    // toda la grant y con ella una conexión activa de la misma cuenta. El
    // candidato queda exclusivamente en Vault y expira del lado de Postgres.
    return redirect(
      appSettingsRedirect(config.appBaseUrl, "selection_required"),
    );
  } catch {
    // La respuesta nunca incluye ni registra tokens, errores crudos o datos de
    // la cuenta. La conexión activa anterior tampoco se modifica acá.
    return errorRedirect();
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleGoogleCalendarOAuthCallbackRequest(request));
}
