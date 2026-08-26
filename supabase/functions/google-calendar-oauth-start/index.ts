import {
  buildGoogleAuthorizationUrl,
  createPkcePair,
  googleOAuthConfiguration,
  randomBase64Url,
  safeGoogleErrorCode,
  sha256Hex,
} from "../_shared/google-calendar.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";

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

    const config = googleOAuthConfiguration((name) => Deno.env.get(name));
    const state = randomBase64Url(32);
    const stateHash = await sha256Hex(state);
    const { verifier, challenge } = await createPkcePair();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error } = await client.rpc("create_google_calendar_oauth_state", {
      p_user_id: user.id,
      p_state_hash: stateHash,
      p_code_verifier: verifier,
      p_expires_at: expiresAt,
    });
    if (error) throw new Error("OAUTH_STATE_CREATE_FAILED");

    return jsonResponse(request, {
      authorizationUrl: buildGoogleAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
        codeChallenge: challenge,
        loginHint: user.email,
      }),
    });
  } catch (error) {
    const code = safeGoogleErrorCode(error);
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
    }
    return jsonResponse(
      request,
      {
        error: code,
        message: "No pudimos iniciar la conexión con Google Calendar.",
      },
      code.endsWith("_MISSING") || code.endsWith("_INVALID") ? 503 : 500,
    );
  }
});
