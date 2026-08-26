import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsRedirect,
  buildGoogleAuthorizationUrl,
  deleteGoogleCalendarEvent,
  deterministicGoogleEventId,
  GOOGLE_CALENDAR_SCOPE,
  GoogleIntegrationError,
  googleCalendarEventPayload,
  googleErrorRetryable,
  googleOAuthConfiguration,
  isRetryableGoogleStatus,
  refreshGoogleAccessToken,
  reuseOrCreateManagedGoogleCalendar,
  retryDelaySeconds,
  sha256Base64Url,
  sha256Hex,
  upsertGoogleCalendarEvent,
  type CalendarSyncAppointment,
} from "./google-calendar.ts";

const appointment: CalendarSyncAppointment = {
  appointment_id: "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1",
  starts_at: "2026-08-20T13:00:00.000Z",
  ends_at: "2026-08-20T13:45:00.000Z",
  patient_name: "  Ana   Pérez ",
  timezone: "America/Argentina/Buenos_Aires",
};

test("OAuth usa state, PKCE S256, acceso offline y el scope mínimo", () => {
  const authorizationUrl = new URL(
    buildGoogleAuthorizationUrl({
      clientId: "client-id",
      redirectUri:
        "https://project.supabase.co/functions/v1/google-calendar-oauth-callback",
      state: "opaque-state",
      codeChallenge: "pkce-challenge",
      loginHint: "gisela@example.com",
    }),
  );

  assert.equal(authorizationUrl.origin, "https://accounts.google.com");
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizationUrl.searchParams.get("prompt"), "consent");
  assert.equal(authorizationUrl.searchParams.get("state"), "opaque-state");
  assert.equal(
    authorizationUrl.searchParams.get("code_challenge_method"),
    "S256",
  );
  assert.deepEqual(authorizationUrl.searchParams.get("scope")?.split(" "), [
    "openid",
    "email",
    GOOGLE_CALENDAR_SCOPE,
  ]);
});

test("hashes de state y PKCE usan SHA-256 sin relleno", async () => {
  assert.equal(
    await sha256Base64Url("test"),
    "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg",
  );
  assert.equal(
    await sha256Hex("test"),
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  );
});

test("configuración y retorno usan URLs fijas y seguras", () => {
  const values: Record<string, string> = {
    GOOGLE_CALENDAR_CLIENT_ID: "client",
    GOOGLE_CALENDAR_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_REDIRECT_URI:
      "https://project.supabase.co/functions/v1/google-calendar-oauth-callback",
    APP_BASE_URL: "https://agenda.example.com/",
  };
  const config = googleOAuthConfiguration((name) => values[name]);
  assert.equal(config.appBaseUrl, "https://agenda.example.com");
  assert.equal(
    appSettingsRedirect(config.appBaseUrl, "connected"),
    "https://agenda.example.com/app/settings?section=calendar&google_calendar=connected",
  );

  values.APP_BASE_URL = "https://user:password@agenda.example.com";
  assert.throws(
    () => googleOAuthConfiguration((name) => values[name]),
    /APP_BASE_URL_INVALID/,
  );
  values.APP_BASE_URL = "https://agenda.example.com/ruta-arbitraria";
  assert.throws(
    () => googleOAuthConfiguration((name) => values[name]),
    /APP_BASE_URL_INVALID/,
  );
});

test("el id del evento es determinista y compatible con Google", () => {
  const id = deterministicGoogleEventId(appointment.appointment_id);
  assert.equal(id, "gl8c4b7679f3b84bd898cba5a57a49b9e1");
  assert.match(id, /^[0-9a-v]{5,1024}$/);
});

test("el evento excluye teléfono, notas internas y datos del servicio", () => {
  const payload = googleCalendarEventPayload(appointment, true);
  const serialized = JSON.stringify(payload);
  assert.equal(payload.summary, "Turno odontológico · Ana Pérez");
  assert.equal(payload.visibility, "private");
  assert.equal(payload.status, "confirmed");
  assert.equal(
    payload.extendedProperties.private.appointment_id,
    appointment.appointment_id,
  );
  assert.equal(serialized.includes("phone"), false);
  assert.equal(serialized.includes("internal_note"), false);
  assert.equal(serialized.includes("service"), false);
});

test("insert en conflicto continúa con PATCH y sendUpdates=none", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
    });
    return new Response(null, {
      status: requests.length === 1 ? 409 : 200,
    });
  }) as typeof fetch;

  const result = await upsertGoogleCalendarEvent({
    accessToken: "not-a-real-token",
    calendarId: "private-calendar@example.com",
    appointment,
    fetcher,
  });

  assert.equal(result.operation, "patched");
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "PATCH"],
  );
  assert.ok(requests.every(({ url }) => url.endsWith("?sendUpdates=none")));
  assert.equal(JSON.parse(requests[0].body).id, result.eventId);
  assert.equal(JSON.parse(requests[1].body).id, undefined);
});

test("un tombstone de Google se reintenta sin inventar otro event id", async () => {
  let calls = 0;
  await assert.rejects(
    upsertGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "private-calendar@example.com",
      appointment,
      fetcher: (async () => {
        calls += 1;
        return new Response(null, { status: calls === 1 ? 409 : 410 });
      }) as typeof fetch,
    }),
    (error) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENT_TOMBSTONED" &&
      googleErrorRetryable(error),
  );
  assert.equal(calls, 2);
});

test("si el calendario dedicado desapareció pide reconectar", async () => {
  await assert.rejects(
    upsertGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "deleted-calendar@example.com",
      appointment,
      fetcher: (async () =>
        new Response(null, { status: 404 })) as typeof fetch,
    }),
    (error) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_CALENDAR_RECONNECT_REQUIRED" &&
      googleErrorRetryable(error),
  );
});

test("una reconexión reutiliza el calendario accesible y evita duplicados", async () => {
  let calls = 0;
  const result = await reuseOrCreateManagedGoogleCalendar({
    accessToken: "not-a-real-token",
    existingCalendarId: "existing-calendar@example.com",
    timezone: appointment.timezone,
    fetcher: (async () => {
      calls += 1;
      return Response.json({
        id: "existing-calendar@example.com",
        summary: "Gisela Lentz · Turnos",
      });
    }) as typeof fetch,
  });
  assert.equal(calls, 1);
  assert.equal(result.reused, true);
  assert.equal(result.id, "existing-calendar@example.com");
});

test("si el calendario anterior ya no es accesible crea uno nuevo", async () => {
  const methods: string[] = [];
  const result = await reuseOrCreateManagedGoogleCalendar({
    accessToken: "not-a-real-token",
    existingCalendarId: "old-calendar@example.com",
    timezone: appointment.timezone,
    fetcher: (async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return methods.length === 1
        ? new Response(null, { status: 404 })
        : Response.json({
            id: "new-calendar@example.com",
            summary: "Gisela Lentz · Turnos",
          });
    }) as typeof fetch,
  });
  assert.deepEqual(methods, ["GET", "POST"]);
  assert.equal(result.reused, false);
  assert.equal(result.id, "new-calendar@example.com");
});

test("borrar un evento inexistente o ya eliminado es idempotente", async () => {
  for (const status of [404, 410]) {
    await deleteGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "private-calendar@example.com",
      appointmentId: appointment.appointment_id,
      fetcher: (async () => new Response(null, { status })) as typeof fetch,
    });
  }
});

test("invalid_grant sólo expone el estado reconectar", async () => {
  await assert.rejects(
    refreshGoogleAccessToken({
      refreshToken: "never-log-this-token",
      config: {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "https://example.com/callback",
        appBaseUrl: "https://example.com",
      },
      fetcher: (async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    }),
    (error) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_RECONNECT_REQUIRED" &&
      !error.message.includes("never-log-this-token"),
  );
});

test("fallos de red se consideran transitorios sin filtrar el error crudo", async () => {
  await assert.rejects(
    refreshGoogleAccessToken({
      refreshToken: "never-log-this-token",
      config: {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "https://example.com/callback",
        appBaseUrl: "https://example.com",
      },
      fetcher: (async () => {
        throw new TypeError("network failed with secret details");
      }) as typeof fetch,
    }),
    (error) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_NETWORK_FAILED" &&
      googleErrorRetryable(error) &&
      !error.message.includes("secret details"),
  );
});

test("rate limits 403 se reintentan pero permisos 403 permanentes no", async () => {
  const run = async (reason: string) =>
    refreshGoogleAccessToken({
      refreshToken: "refresh",
      config: {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "https://example.com/callback",
        appBaseUrl: "https://example.com",
      },
      fetcher: (async () =>
        new Response(JSON.stringify({ error: { errors: [{ reason }] } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    });

  await assert.rejects(run("rateLimitExceeded"), (error) =>
    googleErrorRetryable(error),
  );
  await assert.rejects(
    run("forbidden"),
    (error) => !googleErrorRetryable(error),
  );
});

test("backoff queda acotado y reintenta sólo estados transitorios", () => {
  assert.deepEqual([1, 2, 3, 4].map(retryDelaySeconds), [30, 60, 120, 240]);
  assert.equal(retryDelaySeconds(99), 15_360);
  assert.equal(isRetryableGoogleStatus(429), true);
  assert.equal(isRetryableGoogleStatus(503), true);
  assert.equal(isRetryableGoogleStatus(403), false);
});
