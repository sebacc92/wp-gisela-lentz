import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsRedirect,
  buildGoogleAuthorizationUrl,
  type CalendarSyncAppointment,
  classifyGoogleCalendarEvent,
  classifyGoogleCalendarEventAsExternal,
  deleteGoogleCalendarEvent,
  deterministicGoogleEventId,
  getGoogleCalendarEvent,
  getOwnedGoogleCalendar,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_LIST_SCOPE,
  googleCalendarEventPayload,
  googleErrorRetryable,
  GoogleIntegrationError,
  googleOAuthConfiguration,
  isRetryableGoogleStatus,
  listGoogleCalendarEvents,
  listOwnedGoogleCalendars,
  refreshGoogleAccessToken,
  retryDelaySeconds,
  sha256Base64Url,
  sha256Hex,
  upsertGoogleCalendarEvent,
} from "./google-calendar.ts";

const appointment: CalendarSyncAppointment = {
  appointment_id: "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1",
  starts_at: "2026-08-20T13:00:00.000Z",
  ends_at: "2026-08-20T13:45:00.000Z",
  patient_name: "  Ana   Pérez ",
  timezone: "America/Argentina/Buenos_Aires",
};

test("OAuth usa PKCE y sólo identidad, calendar list y eventos propios", () => {
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
  assert.equal(
    authorizationUrl.searchParams.get("include_granted_scopes"),
    "false",
  );
  assert.equal(authorizationUrl.searchParams.get("state"), "opaque-state");
  assert.equal(
    authorizationUrl.searchParams.get("code_challenge_method"),
    "S256",
  );
  assert.deepEqual(authorizationUrl.searchParams.get("scope")?.split(" "), [
    "openid",
    "email",
    GOOGLE_CALENDAR_LIST_SCOPE,
    GOOGLE_CALENDAR_EVENTS_SCOPE,
  ]);
  assert.equal(
    authorizationUrl.searchParams
      .get("scope")
      ?.includes("calendar.app.created"),
    false,
  );
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
  assert.equal(
    appSettingsRedirect(config.appBaseUrl, "selection_required"),
    "https://agenda.example.com/app/settings?section=calendar&google_calendar=selection_required",
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

test("si el calendario seleccionado desapareció pide reconectar", async () => {
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

test("lista todos los calendarios owner paginando y filtra roles localmente", async () => {
  const requests: URL[] = [];
  const methods: string[] = [];
  const authorizations: Array<string | null> = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    requests.push(url);
    methods.push(init?.method ?? "GET");
    authorizations.push(new Headers(init?.headers).get("authorization"));
    if (requests.length === 1) {
      return Response.json({
        nextPageToken: "next-owner-page",
        items: [
          {
            id: "writer-calendar@example.com",
            summary: "Compartido",
            timeZone: appointment.timezone,
            accessRole: "writer",
          },
          {
            id: "secondary-owner@example.com",
            summary: "Turnos",
            timeZone: appointment.timezone,
            accessRole: "owner",
          },
          {
            id: "deleted-owner@example.com",
            summary: "Borrado",
            timeZone: appointment.timezone,
            accessRole: "owner",
            deleted: true,
          },
        ],
      });
    }
    return Response.json({
      items: [
        {
          id: "primary-owner@example.com",
          summary: "Principal",
          timeZone: appointment.timezone,
          accessRole: "owner",
          primary: true,
        },
        // Un item repetido entre páginas no debe duplicarse.
        {
          id: "secondary-owner@example.com",
          summary: "Turnos",
          timeZone: appointment.timezone,
          accessRole: "owner",
        },
      ],
    });
  }) as typeof fetch;

  const result = await listOwnedGoogleCalendars({
    accessToken: "not-a-real-token",
    fetcher,
  });

  assert.deepEqual(result, [
    {
      id: "primary-owner@example.com",
      name: "Principal",
      timeZone: appointment.timezone,
      primary: true,
    },
    {
      id: "secondary-owner@example.com",
      name: "Turnos",
      timeZone: appointment.timezone,
      primary: false,
    },
  ]);
  assert.deepEqual(methods, ["GET", "GET"]);
  assert.deepEqual(authorizations, [
    "Bearer not-a-real-token",
    "Bearer not-a-real-token",
  ]);
  assert.equal(requests[0].searchParams.get("minAccessRole"), "owner");
  assert.equal(requests[0].searchParams.get("maxResults"), "250");
  assert.equal(requests[0].searchParams.get("showDeleted"), "false");
  assert.equal(requests[0].searchParams.get("showHidden"), "true");
  assert.equal(requests[0].searchParams.has("pageToken"), false);
  assert.equal(requests[1].searchParams.get("pageToken"), "next-owner-page");
});

test("revalida un CalendarList item owner por ID sin hacer escrituras", async () => {
  let observedUrl: URL | undefined;
  let observedMethod = "";
  const result = await getOwnedGoogleCalendar({
    accessToken: "not-a-real-token",
    calendarId: "owned/calendar@example.com",
    fetcher: (async (input, init) => {
      observedUrl = new URL(String(input));
      observedMethod = init?.method ?? "GET";
      return Response.json({
        id: "owned/calendar@example.com",
        summary: "Agenda existente",
        timeZone: appointment.timezone,
        accessRole: "owner",
      });
    }) as typeof fetch,
  });

  assert.equal(
    observedUrl?.pathname,
    "/calendar/v3/users/me/calendarList/owned%2Fcalendar%40example.com",
  );
  assert.equal(observedMethod, "GET");
  assert.deepEqual(result, {
    id: "owned/calendar@example.com",
    name: "Agenda existente",
    timeZone: appointment.timezone,
    primary: false,
  });
});

test("rechaza al confirmar un calendario writer aunque Google lo devuelva", async () => {
  await assert.rejects(
    getOwnedGoogleCalendar({
      accessToken: "not-a-real-token",
      calendarId: "writer-calendar@example.com",
      fetcher: (async () =>
        Response.json({
          id: "writer-calendar@example.com",
          summary: "Compartido",
          timeZone: appointment.timezone,
          accessRole: "writer",
        })) as typeof fetch,
    }),
    (error) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_CALENDAR_OWNER_REQUIRED" &&
      error.status === 409,
  );
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

test("un evento administrado por la app se reconoce por sus propiedades privadas", () => {
  const classified = classifyGoogleCalendarEvent({
    id: "gl8c4b7679f3b84bd898cba5a57a49b9e1",
    status: "confirmed",
    updated: "2026-09-02T10:00:00.000Z",
    extendedProperties: {
      private: {
        managed_by: "gisela_lentz_agenda",
        appointment_id: "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1",
      },
    },
    start: { dateTime: "2026-09-04T14:00:00.000Z" },
    end: { dateTime: "2026-09-04T14:30:00.000Z" },
  });
  assert.equal(classified.kind, "managed");
  assert.equal(
    classified.kind === "managed" ? classified.appointmentId : "",
    "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1",
  );
  assert.equal(
    classified.kind === "managed" ? classified.cancelled : true,
    false,
  );
});

test("un marcador managed legado puede reclasificarse sólo por su forma externa", () => {
  const legacyManaged = {
    id: "gl8c4b7679f3b84bd898cba5a57a49b9e1",
    status: "confirmed",
    summary: "Evento legado",
    extendedProperties: {
      private: {
        managed_by: "gisela_lentz_agenda",
        appointment_id: "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1",
      },
    },
    start: { dateTime: "2026-09-07T14:00:00.000Z" },
    end: { dateTime: "2026-09-07T15:00:00.000Z" },
  };

  assert.equal(classifyGoogleCalendarEvent(legacyManaged).kind, "managed");
  const fallback = classifyGoogleCalendarEventAsExternal(legacyManaged);
  assert.equal(fallback.kind, "external_block");
  if (fallback.kind !== "external_block") return;
  assert.equal(fallback.eventId, legacyManaged.id);
  assert.equal(fallback.summary, "Evento legado");
  assert.equal(fallback.startsAt, "2026-09-07T14:00:00.000Z");
  assert.equal(fallback.endsAt, "2026-09-07T15:00:00.000Z");

  assert.equal(
    classifyGoogleCalendarEventAsExternal({
      ...legacyManaged,
      status: "cancelled",
      start: undefined,
      end: undefined,
    }).kind,
    "external_removed",
  );
  assert.equal(
    classifyGoogleCalendarEventAsExternal({
      ...legacyManaged,
      start: { date: "2026-09-07" },
      end: { date: "2026-09-08" },
    }).kind,
    "external_unsupported",
  );
});

test("el id determinista alcanza si alguien borró las propiedades privadas", () => {
  const classified = classifyGoogleCalendarEvent({
    id: "gl8c4b7679f3b84bd898cba5a57a49b9e1",
    status: "cancelled",
  });
  assert.equal(classified.kind, "managed");
  assert.equal(
    classified.kind === "managed" ? classified.appointmentId : "",
    "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1",
  );
  assert.equal(
    classified.kind === "managed" ? classified.cancelled : false,
    true,
  );
});

test("un id determinista que contradice las propiedades managed falla cerrado", () => {
  const classified = classifyGoogleCalendarEvent({
    id: "gl8c4b7679f3b84bd898cba5a57a49b9e1",
    status: "confirmed",
    extendedProperties: {
      private: {
        managed_by: "gisela_lentz_agenda",
        appointment_id: "9d5c878a-a4c9-4ce9-89dc-b6b68b50caf2",
      },
    },
    start: { dateTime: "2026-09-04T14:00:00.000Z" },
    end: { dateTime: "2026-09-04T14:30:00.000Z" },
  });

  assert.deepEqual(classified, {
    kind: "managed_mismatch",
    eventId: "gl8c4b7679f3b84bd898cba5a57a49b9e1",
    reason: "APPOINTMENT_ID_MISMATCH",
  });
});

test("un tombstone externo conserva únicamente un ETag saneado", () => {
  const classified = classifyGoogleCalendarEvent({
    id: "evento-opaco-borrado",
    status: "cancelled",
    etag: '  "etag-tombstone"  ',
    updated: "2026-09-04T10:00:00.000Z",
  });
  assert.equal(classified.kind, "external_removed");
  if (classified.kind !== "external_removed") return;
  assert.equal(classified.etag, '"etag-tombstone"');

  const unsafe = classifyGoogleCalendarEvent({
    id: "evento-opaco-borrado-2",
    status: "cancelled",
    etag: '"etag\r\ninvalido"',
  });
  assert.equal(unsafe.kind, "external_removed");
  assert.equal(unsafe.kind === "external_removed" ? unsafe.etag : "", null);
});

test("un evento creado a mano se clasifica como bloqueo con título acotado", () => {
  const classified = classifyGoogleCalendarEvent({
    id: "evento-manual",
    summary: `  ${"t".repeat(200)}  `,
    etag: '"etag-value"',
    start: { dateTime: "2026-09-04T14:00:00.000Z" },
    end: { dateTime: "2026-09-04T15:00:00.000Z" },
  });
  assert.equal(classified.kind, "external_block");
  if (classified.kind !== "external_block") return;
  assert.equal(classified.summary?.length, 120);
  assert.equal(classified.startsAt, "2026-09-04T14:00:00.000Z");
  assert.equal(classified.endsAt, "2026-09-04T15:00:00.000Z");
});

test("todo el día, recurrente y rango inválido quedan como no soportados", () => {
  const allDay = classifyGoogleCalendarEvent({
    id: "a",
    start: { date: "2026-09-05" },
    end: { date: "2026-09-06" },
  });
  const recurring = classifyGoogleCalendarEvent({
    id: "b",
    recurrence: ["RRULE:FREQ=WEEKLY"],
    start: { dateTime: "2026-09-04T14:00:00.000Z" },
    end: { dateTime: "2026-09-04T15:00:00.000Z" },
  });
  const instance = classifyGoogleCalendarEvent({
    id: "c",
    recurringEventId: "b",
    start: { dateTime: "2026-09-04T14:00:00.000Z" },
    end: { dateTime: "2026-09-04T15:00:00.000Z" },
  });
  const inverted = classifyGoogleCalendarEvent({
    id: "d",
    start: { dateTime: "2026-09-04T15:00:00.000Z" },
    end: { dateTime: "2026-09-04T14:00:00.000Z" },
  });
  const missing = classifyGoogleCalendarEvent({ id: "e" });

  assert.equal(
    allDay.kind === "external_unsupported" ? allDay.reason : "",
    "ALL_DAY",
  );
  assert.equal(
    recurring.kind === "external_unsupported" ? recurring.reason : "",
    "RECURRING",
  );
  assert.equal(
    instance.kind === "external_unsupported" ? instance.reason : "",
    "RECURRING",
  );
  assert.equal(
    inverted.kind === "external_unsupported" ? inverted.reason : "",
    "INVALID_RANGE",
  );
  assert.equal(
    missing.kind === "external_unsupported" ? missing.reason : "",
    "MISSING_RANGE",
  );
});

test("events.list pide showDeleted, pagina y devuelve el sync token", async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = (input) => {
    const url = String(input);
    requested.push(url);
    const body = url.includes("pageToken=page-2")
      ? { items: [{ id: "b" }], nextSyncToken: "sync-token" }
      : { items: [{ id: "a" }], nextPageToken: "page-2" };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const first = await listGoogleCalendarEvents({
    accessToken: "token",
    calendarId: "calendar-id",
    fetcher,
  });
  assert.equal(first.nextPageToken, "page-2");
  assert.equal(first.nextSyncToken, null);

  const second = await listGoogleCalendarEvents({
    accessToken: "token",
    calendarId: "calendar-id",
    pageToken: first.nextPageToken,
    fetcher,
  });
  assert.equal(second.nextPageToken, null);
  assert.equal(second.nextSyncToken, "sync-token");
  assert.ok(requested[0].includes("showDeleted=true"));
  assert.ok(!requested[0].includes("singleEvents"));
  assert.ok(requested[1].includes("pageToken=page-2"));
});

test("al paginar una corrida incremental el syncToken viaja en cada página", async () => {
  let requestedUrl = "";
  const fetcher: typeof fetch = (input) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(JSON.stringify({ items: [], nextSyncToken: "next" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  await listGoogleCalendarEvents({
    accessToken: "token",
    calendarId: "calendar-id",
    syncToken: "sync-1",
    pageToken: "page-2",
    fetcher,
  });
  // Google exige el mismo juego de parámetros en todas las páginas.
  assert.ok(requestedUrl.includes("syncToken=sync-1"));
  assert.ok(requestedUrl.includes("pageToken=page-2"));
  assert.equal(new URL(requestedUrl).searchParams.get("timeMin"), null);
});

test("events.list conserva timeMin y el tamaño máximo durante un full sync", async () => {
  const requested: URL[] = [];
  const cutoff = "2026-09-04T15:30:00.000Z";
  const fetcher: typeof fetch = (input) => {
    requested.push(new URL(String(input)));
    return Promise.resolve(
      new Response(JSON.stringify({ items: [], nextSyncToken: "next" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  await listGoogleCalendarEvents({
    accessToken: "token",
    calendarId: "calendar-id",
    timeMin: cutoff,
    maxResults: 2500,
    fetcher,
  });
  await listGoogleCalendarEvents({
    accessToken: "token",
    calendarId: "calendar-id",
    timeMin: cutoff,
    pageToken: "page-2",
    maxResults: 2500,
    fetcher,
  });

  assert.equal(requested.length, 2);
  for (const url of requested) {
    assert.equal(url.searchParams.get("timeMin"), cutoff);
    assert.equal(url.searchParams.get("maxResults"), "2500");
    assert.equal(url.searchParams.get("syncToken"), null);
  }
  assert.equal(requested[0].searchParams.get("pageToken"), null);
  assert.equal(requested[1].searchParams.get("pageToken"), "page-2");
});

test("events.list rechaza timeMin junto a syncToken antes de usar la red", async () => {
  let fetches = 0;
  const fetcher: typeof fetch = () => {
    fetches += 1;
    return Promise.resolve(new Response("{}"));
  };

  await assert.rejects(
    () =>
      listGoogleCalendarEvents({
        accessToken: "token",
        calendarId: "calendar-id",
        syncToken: "sync-1",
        timeMin: "2026-09-04T15:30:00.000Z",
        fetcher,
      }),
    (error: unknown) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENTS_LIST_PARAMETERS_INVALID" &&
      error.status === 400,
  );
  assert.equal(fetches, 0);
});

test("un syncToken vencido se reporta como 410 sin marcar reconexión", async () => {
  const fetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { message: "gone" } }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      }),
    );

  await assert.rejects(
    () =>
      listGoogleCalendarEvents({
        accessToken: "token",
        calendarId: "calendar-id",
        syncToken: "expired",
        fetcher,
      }),
    (error: unknown) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_SYNC_TOKEN_EXPIRED" &&
      error.status === 410,
  );
});

test("events.get codifica IDs y devuelve un evento válido sin escribir", async () => {
  const requests: Array<{
    url: URL;
    method: string;
    authorization: string | null;
  }> = [];
  const eventId = "evento/con espacios";
  const result = await getGoogleCalendarEvent({
    accessToken: "token-sintetico",
    calendarId: "calendar/id@example.com",
    eventId,
    fetcher: (async (input, init) => {
      requests.push({
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        id: eventId,
        status: "confirmed",
        summary: "Evento sintético",
      });
    }) as typeof fetch,
  });

  assert.equal(result.kind, "found");
  assert.equal(result.kind === "found" ? result.event.id : null, eventId);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(
    request.url.pathname,
    "/calendar/v3/calendars/calendar%2Fid%40example.com/events/evento%2Fcon%20espacios",
  );
  assert.equal(request.url.search, "");
  assert.equal(request.method, "GET");
  assert.equal(request.authorization, "Bearer token-sintetico");
});

test("events.get distingue ausencia 404 de tombstone 410", async () => {
  for (const [status, expectedKind] of [
    [404, "missing"],
    [410, "tombstone"],
  ] as const) {
    const result = await getGoogleCalendarEvent({
      accessToken: "token-sintetico",
      calendarId: "calendar-id",
      eventId: "event-id",
      fetcher: (async () =>
        new Response("detalle remoto sensible", { status })) as typeof fetch,
    });
    assert.equal(result.kind, expectedKind);
  }
});

test("events.get sanea errores remotos y rechaza respuestas 200 ambiguas", async () => {
  await assert.rejects(
    () =>
      getGoogleCalendarEvent({
        accessToken: "token-sintetico",
        calendarId: "calendar-id",
        eventId: "event-id",
        fetcher: (async () =>
          Response.json(
            { error: { message: "detalle-remoto-no-debe-salir" } },
            { status: 403 },
          )) as typeof fetch,
      }),
    (error: unknown) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENT_GET_FAILED" &&
      error.message === "GOOGLE_EVENT_GET_FAILED" &&
      !error.message.includes("detalle-remoto"),
  );

  for (const body of [{}, [], { id: "otro-evento" }]) {
    await assert.rejects(
      () =>
        getGoogleCalendarEvent({
          accessToken: "token-sintetico",
          calendarId: "calendar-id",
          eventId: "event-id",
          fetcher: (async () => Response.json(body)) as typeof fetch,
        }),
      (error: unknown) =>
        error instanceof GoogleIntegrationError &&
        error.code === "GOOGLE_EVENT_GET_RESPONSE_INVALID" &&
        error.status === 502,
    );
  }

  await assert.rejects(
    () =>
      getGoogleCalendarEvent({
        accessToken: "token-sintetico",
        calendarId: "calendar-id",
        eventId: "event-id",
        fetcher: (async () =>
          Response.json({ id: "event-id" }, { status: 201 })) as typeof fetch,
      }),
    (error: unknown) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENT_GET_RESPONSE_INVALID" &&
      error.status === 502,
  );
});
