import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsRedirect,
  buildGoogleAuthorizationUrl,
  type CalendarSyncAppointment,
  classifyGoogleCalendarEvent,
  classifyGoogleCalendarEventAsExternal,
  deleteManagedGoogleCalendarEvent,
  deterministicGoogleEventId,
  getGoogleCalendarEvent,
  getOwnedGoogleCalendar,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_LIST_SCOPE,
  googleCalendarDateStart,
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
const AUTOMATION_EPOCH = "77777777-7777-4777-8777-777777777777";
const association = {
  eventId: "persisted-event-id",
  automationEpoch: AUTOMATION_EPOCH,
  projectionStage: "confirmed" as const,
  projectedStage: "pre_reservation" as const,
};

function googleEventsPage(
  page: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "calendar#events",
    timeZone: appointment.timezone,
    accessRole: "owner",
    ...page,
  };
}

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

test("el evento excluye teléfono, notas internas y datos del servicio", async () => {
  const payload = await googleCalendarEventPayload(
    appointment,
    association,
    true,
  );
  const serialized = JSON.stringify(payload);
  assert.equal(payload.summary, "Turno confirmado · Ana Pérez");
  assert.equal(payload.visibility, "private");
  assert.equal(payload.status, "confirmed");
  assert.equal(
    payload.extendedProperties.private.appointment_id,
    appointment.appointment_id,
  );
  assert.equal(
    payload.extendedProperties.private.automation_epoch,
    AUTOMATION_EPOCH,
  );
  assert.equal(
    payload.extendedProperties.private.projection_stage,
    "confirmed",
  );
  assert.equal(payload.id, association.eventId);
  assert.equal(serialized.includes("phone"), false);
  assert.equal(serialized.includes("internal_note"), false);
  assert.equal(serialized.includes("service"), false);

  const pendingPayload = await googleCalendarEventPayload(appointment, {
    ...association,
    projectionStage: "pre_reservation",
  });
  assert.equal(pendingPayload.summary, "Pendiente de seña · Ana Pérez");
  assert.equal(
    pendingPayload.extendedProperties.private.projection_stage,
    "pre_reservation",
  );
});

test("insert en conflicto sólo parchea una asociación propia del mismo epoch", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  let authorizations = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
    });
    if (requests.length === 1) return new Response(null, { status: 409 });
    if (requests.length === 2) {
      return Response.json({
        id: association.eventId,
        etag: '"owned-etag"',
        extendedProperties: {
          private: {
            managed_by: "gisela_lentz_agenda",
            appointment_id: appointment.appointment_id,
            automation_epoch: AUTOMATION_EPOCH,
            projection_stage: "pre_reservation",
          },
        },
      });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const result = await upsertGoogleCalendarEvent({
    accessToken: "not-a-real-token",
    calendarId: "private-calendar@example.com",
    appointment,
    association,
    beforeMutation: () => {
      authorizations += 1;
      return Promise.resolve();
    },
    etag: '"owned-etag"',
    fetcher,
  });

  assert.equal(result.operation, "patched");
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "GET", "PATCH"],
  );
  assert.equal(authorizations, 2);
  assert.equal(requests[0].url.endsWith("?sendUpdates=none"), true);
  assert.equal(requests[1].url.endsWith("?sendUpdates=none"), false);
  assert.equal(requests[2].url.endsWith("?sendUpdates=none"), true);
  assert.equal(JSON.parse(requests[0].body).id, result.eventId);
  assert.equal(JSON.parse(requests[2].body).id, undefined);
});

test("un 409 ajeno nunca se convierte en PATCH", async () => {
  const methods: string[] = [];
  let authorizations = 0;
  await assert.rejects(
    upsertGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "private-calendar@example.com",
      appointment,
      association,
      beforeMutation: () => {
        authorizations += 1;
        return Promise.resolve();
      },
      fetcher: (async (_input, init) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method === "POST") return new Response(null, { status: 409 });
        return Response.json({
          id: association.eventId,
          extendedProperties: {
            private: {
              managed_by: "otra_integracion",
              appointment_id: appointment.appointment_id,
            },
          },
        });
      }) as typeof fetch,
    }),
    (error) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENT_OWNERSHIP_CONFLICT" &&
      !googleErrorRetryable(error),
  );
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(authorizations, 1);
});

test("un cambio humano de ETag entre pull y push nunca se sobreescribe", async () => {
  const methods: string[] = [];
  let authorizations = 0;
  await assert.rejects(
    upsertGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "private-calendar@example.com",
      appointment,
      association,
      etag: '"etag-del-pull"',
      beforeMutation: () => {
        authorizations += 1;
        return Promise.resolve();
      },
      fetcher: (async (_input, init) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method === "POST") return new Response(null, { status: 409 });
        return Response.json({
          id: association.eventId,
          etag: '"etag-editado-en-google"',
          summary: "Turno confirmado · Ana Pérez",
          extendedProperties: {
            private: {
              managed_by: "gisela_lentz_agenda",
              appointment_id: appointment.appointment_id,
              automation_epoch: AUTOMATION_EPOCH,
              projection_stage: "confirmed",
            },
          },
          start: { dateTime: appointment.starts_at },
          end: { dateTime: appointment.ends_at },
        });
      }) as typeof fetch,
    }),
    (error) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENT_PRECONDITION_FAILED" &&
      googleErrorRetryable(error),
  );
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(authorizations, 1);
});

test("una respuesta de insert perdida sólo adopta un evento propio idéntico", async () => {
  const methods: string[] = [];
  let authorizations = 0;
  const remotePayload = await googleCalendarEventPayload(
    appointment,
    association,
    true,
  );
  const result = await upsertGoogleCalendarEvent({
    accessToken: "not-a-real-token",
    calendarId: "private-calendar@example.com",
    appointment,
    association: { ...association, projectedStage: null },
    beforeMutation: () => {
      authorizations += 1;
      return Promise.resolve();
    },
    fetcher: (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") return new Response(null, { status: 409 });
      return Response.json({ ...remotePayload, etag: '"created-etag"' });
    }) as typeof fetch,
  });

  assert.equal(result.operation, "adopted");
  assert.equal(result.etag, '"created-etag"');
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(authorizations, 1);
});

test("una respuesta perdida no adopta payload con descripción o marker alterados", async () => {
  const remotePayload = await googleCalendarEventPayload(
    appointment,
    association,
    true,
  );
  for (const remoteDrift of [
    { description: "Descripción editada manualmente" },
    { location: "Consultorio agregado manualmente" },
    { colorId: "11" },
    { reminders: { useDefault: false, overrides: [] } },
    {
      extendedProperties: {
        private: {
          managed_by: "gisela_lentz_agenda",
          appointment_id: appointment.appointment_id,
          automation_epoch: AUTOMATION_EPOCH,
          projection_stage: "confirmed",
          marker_extra: "manual",
        },
      },
    },
  ]) {
    const methods: string[] = [];
    await assert.rejects(
      upsertGoogleCalendarEvent({
        accessToken: "not-a-real-token",
        calendarId: "private-calendar@example.com",
        appointment,
        association: { ...association, projectedStage: null },
        beforeMutation: () => Promise.resolve(),
        fetcher: (async (_input, init) => {
          const method = init?.method ?? "GET";
          methods.push(method);
          if (method === "POST") return new Response(null, { status: 409 });
          return Response.json({
            ...remotePayload,
            etag: '"created-etag"',
            ...remoteDrift,
          });
        }) as typeof fetch,
      }),
      (error) =>
        error instanceof GoogleIntegrationError &&
        error.code === "GOOGLE_EVENT_OWNERSHIP_CONFLICT",
    );
    assert.deepEqual(methods, ["POST", "GET"]);
  }
});

test("un POST pendiente perdido se recupera con el mismo ID al confirmar o reprogramar", async () => {
  const pendingAssociation = {
    ...association,
    projectionStage: "pre_reservation" as const,
    projectedStage: null,
  };
  const pendingPayload = await googleCalendarEventPayload(
    appointment,
    pendingAssociation,
    true,
  );
  const cases = [
    {
      name: "confirmación",
      desiredAppointment: appointment,
      desiredAssociation: { ...association, projectedStage: null },
    },
    {
      name: "reprogramación",
      desiredAppointment: {
        ...appointment,
        starts_at: "2026-09-09T15:00:00.000Z",
        ends_at: "2026-09-09T15:30:00.000Z",
      },
      desiredAssociation: pendingAssociation,
    },
  ];

  for (const recoveryCase of cases) {
    const requests: Array<{
      method: string;
      url: string;
      ifMatch: string | null;
      body: string;
    }> = [];
    let authorizations = 0;
    const result = await upsertGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "private-calendar@example.com",
      appointment: recoveryCase.desiredAppointment,
      association: recoveryCase.desiredAssociation,
      beforeMutation: () => {
        authorizations += 1;
        return Promise.resolve();
      },
      fetcher: (async (input, init) => {
        const method = init?.method ?? "GET";
        requests.push({
          method,
          url: String(input),
          ifMatch: new Headers(init?.headers).get("if-match"),
          body: String(init?.body ?? ""),
        });
        if (method === "POST") return new Response(null, { status: 409 });
        if (method === "GET") {
          return Response.json({
            ...pendingPayload,
            etag: '"etag-post-pendiente-perdido"',
          });
        }
        return new Response(null, {
          status: 200,
          headers: { ETag: '"etag-version-actual"' },
        });
      }) as typeof fetch,
    });

    assert.equal(result.eventId, association.eventId, recoveryCase.name);
    assert.equal(result.operation, "patched", recoveryCase.name);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["POST", "GET", "PATCH"],
      recoveryCase.name,
    );
    assert.ok(
      requests.every(
        ({ url }) =>
          !url.includes("/events/") || url.includes(association.eventId),
      ),
      recoveryCase.name,
    );
    assert.equal(
      requests[2].ifMatch,
      '"etag-post-pendiente-perdido"',
      recoveryCase.name,
    );
    assert.equal(authorizations, 2, recoveryCase.name);
    const patchedPayload = JSON.parse(requests[2].body);
    assert.equal(
      patchedPayload.extendedProperties.private.projection_stage,
      recoveryCase.desiredAssociation.projectionStage,
      recoveryCase.name,
    );
    assert.match(
      patchedPayload.extendedProperties.private.payload_fingerprint,
      /^[0-9a-f]{64}$/,
      recoveryCase.name,
    );
  }
});

test("un PATCH aplicado cuya respuesta se perdió se adopta sin volver a escribir", async () => {
  const remotePayload = await googleCalendarEventPayload(
    appointment,
    association,
    true,
  );
  const methods: string[] = [];
  let authorizations = 0;
  const result = await upsertGoogleCalendarEvent({
    accessToken: "not-a-real-token",
    calendarId: "private-calendar@example.com",
    appointment,
    association,
    etag: '"etag-anterior-al-patch"',
    beforeMutation: () => {
      authorizations += 1;
      return Promise.resolve();
    },
    fetcher: (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") return new Response(null, { status: 409 });
      return Response.json({
        ...remotePayload,
        etag: '"etag-del-patch-aplicado"',
      });
    }) as typeof fetch,
  });

  assert.deepEqual(result, {
    eventId: association.eventId,
    operation: "adopted",
    etag: '"etag-del-patch-aplicado"',
  });
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(authorizations, 1);
});

test("un tombstone de Google se reintenta sin inventar otro event id", async () => {
  let calls = 0;
  await assert.rejects(
    upsertGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "private-calendar@example.com",
      appointment,
      association,
      beforeMutation: () => Promise.resolve(),
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
      association,
      beforeMutation: () => Promise.resolve(),
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
    await deleteManagedGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "private-calendar@example.com",
      eventId: association.eventId,
      appointmentId: appointment.appointment_id,
      automationEpoch: AUTOMATION_EPOCH,
      beforeMutation: () => Promise.resolve(),
      fetcher: (async () => new Response(null, { status })) as typeof fetch,
    });
  }
});

test("delete usa asociación persistida y reautoriza después de verificar markers", async () => {
  const calls: Array<{ method: string; url: string; ifMatch: string | null }> =
    [];
  let authorizations = 0;
  await deleteManagedGoogleCalendarEvent({
    accessToken: "not-a-real-token",
    calendarId: "private-calendar@example.com",
    eventId: association.eventId,
    appointmentId: appointment.appointment_id,
    automationEpoch: AUTOMATION_EPOCH,
    beforeMutation: () => {
      authorizations += 1;
      return Promise.resolve();
    },
    etag: '"fresh-etag"',
    fetcher: (async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url: String(input),
        ifMatch: new Headers(init?.headers).get("if-match"),
      });
      if (method === "GET") {
        return Response.json({
          id: association.eventId,
          etag: '"fresh-etag"',
          extendedProperties: {
            private: {
              managed_by: "gisela_lentz_agenda",
              appointment_id: appointment.appointment_id,
              automation_epoch: AUTOMATION_EPOCH,
            },
          },
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  assert.equal(authorizations, 1);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "DELETE"],
  );
  assert.ok(calls.every((call) => call.url.includes(association.eventId)));
  assert.equal(calls[1].ifMatch, '"fresh-etag"');
});

test("un POST pendiente perdido puede cancelarse sin duplicar ni perder ownership", async () => {
  const pendingPayload = await googleCalendarEventPayload(
    appointment,
    {
      ...association,
      projectionStage: "pre_reservation",
      projectedStage: null,
    },
    true,
  );
  const calls: Array<{ method: string; ifMatch: string | null }> = [];
  let authorizations = 0;
  await deleteManagedGoogleCalendarEvent({
    accessToken: "not-a-real-token",
    calendarId: "private-calendar@example.com",
    eventId: association.eventId,
    appointmentId: appointment.appointment_id,
    automationEpoch: AUTOMATION_EPOCH,
    beforeMutation: () => {
      authorizations += 1;
      return Promise.resolve();
    },
    etag: null,
    fetcher: (async (_input, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        ifMatch: new Headers(init?.headers).get("if-match"),
      });
      if (method === "GET") {
        return Response.json({
          ...pendingPayload,
          etag: '"etag-post-pendiente-perdido"',
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["GET", "DELETE"],
  );
  assert.equal(calls[1].ifMatch, '"etag-post-pendiente-perdido"');
  assert.equal(authorizations, 1);
});

test("un PATCH aplicado cuya respuesta se perdió puede cancelarse con su ETag observado", async () => {
  const confirmedPayload = await googleCalendarEventPayload(
    appointment,
    association,
    true,
  );
  const calls: Array<{ method: string; ifMatch: string | null }> = [];
  let authorizations = 0;
  await deleteManagedGoogleCalendarEvent({
    accessToken: "not-a-real-token",
    calendarId: "private-calendar@example.com",
    eventId: association.eventId,
    appointmentId: appointment.appointment_id,
    automationEpoch: AUTOMATION_EPOCH,
    beforeMutation: () => {
      authorizations += 1;
      return Promise.resolve();
    },
    etag: '"etag-anterior-al-patch"',
    fetcher: (async (_input, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        ifMatch: new Headers(init?.headers).get("if-match"),
      });
      if (method === "GET") {
        return Response.json({
          ...confirmedPayload,
          etag: '"etag-del-patch-aplicado"',
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["GET", "DELETE"],
  );
  assert.equal(calls[1].ifMatch, '"etag-del-patch-aplicado"');
  assert.equal(authorizations, 1);
});

test("delete sin ETag rechaza un evento propio cuya huella ya no coincide", async () => {
  const pendingPayload = await googleCalendarEventPayload(
    appointment,
    {
      ...association,
      projectionStage: "pre_reservation",
      projectedStage: null,
    },
    true,
  );
  const methods: string[] = [];
  let authorizations = 0;
  await assert.rejects(
    deleteManagedGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "private-calendar@example.com",
      eventId: association.eventId,
      appointmentId: appointment.appointment_id,
      automationEpoch: AUTOMATION_EPOCH,
      beforeMutation: () => {
        authorizations += 1;
        return Promise.resolve();
      },
      etag: null,
      fetcher: (async (_input, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json({
          ...pendingPayload,
          etag: '"etag-humano"',
          location: "Ubicación agregada manualmente",
        });
      }) as typeof fetch,
    }),
    (error) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENT_OWNERSHIP_CONFLICT" &&
      !googleErrorRetryable(error),
  );
  assert.deepEqual(methods, ["GET"]);
  assert.equal(authorizations, 0);
});

test("delete no adopta un ETag editado por una persona", async () => {
  const methods: string[] = [];
  let authorizations = 0;
  await assert.rejects(
    deleteManagedGoogleCalendarEvent({
      accessToken: "not-a-real-token",
      calendarId: "private-calendar@example.com",
      eventId: association.eventId,
      appointmentId: appointment.appointment_id,
      automationEpoch: AUTOMATION_EPOCH,
      beforeMutation: () => {
        authorizations += 1;
        return Promise.resolve();
      },
      etag: '"etag-del-pull"',
      fetcher: (async (_input, init) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        return Response.json({
          id: association.eventId,
          etag: '"etag-editado-en-google"',
          extendedProperties: {
            private: {
              managed_by: "gisela_lentz_agenda",
              appointment_id: appointment.appointment_id,
              automation_epoch: AUTOMATION_EPOCH,
            },
          },
        });
      }) as typeof fetch,
    }),
    (error) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENT_PRECONDITION_FAILED" &&
      googleErrorRetryable(error),
  );
  assert.deepEqual(methods, ["GET"]);
  assert.equal(authorizations, 0);
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
        automation_epoch: AUTOMATION_EPOCH,
        projection_stage: "confirmed",
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
  assert.equal(
    classified.kind === "managed" ? classified.automationEpoch : "",
    AUTOMATION_EPOCH,
  );
  assert.equal(
    classified.kind === "managed" ? classified.projectionStage : "",
    "confirmed",
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

  assert.equal(
    classifyGoogleCalendarEvent(legacyManaged).kind,
    "managed_legacy",
  );
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

test("un id determinista sin marker de epoch queda como legado externo", () => {
  const classified = classifyGoogleCalendarEvent({
    id: "gl8c4b7679f3b84bd898cba5a57a49b9e1",
    status: "cancelled",
  });
  assert.equal(classified.kind, "managed_legacy");
  assert.equal(
    classified.kind === "managed_legacy" ? classified.appointmentId : "",
    "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1",
  );
  assert.equal(
    classifyGoogleCalendarEventAsExternal({
      id: "gl8c4b7679f3b84bd898cba5a57a49b9e1",
      status: "cancelled",
    }).kind,
    "external_removed",
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
        automation_epoch: AUTOMATION_EPOCH,
        projection_stage: "confirmed",
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

test("un dateTime local usa su zona y una hora DST ambigua falla cerrada", () => {
  const local = classifyGoogleCalendarEvent({
    id: "evento-hora-local",
    start: {
      dateTime: "2026-09-08T10:30:00",
      timeZone: "America/Argentina/Buenos_Aires",
    },
    end: {
      dateTime: "2026-09-08T11:30:00",
      timeZone: "America/Argentina/Buenos_Aires",
    },
  });
  assert.equal(local.kind, "external_block");
  assert.equal(
    local.kind === "external_block" ? local.startsAt : "",
    "2026-09-08T13:30:00.000Z",
  );

  const ambiguous = classifyGoogleCalendarEvent({
    id: "evento-hora-local-ambigua",
    start: {
      dateTime: "2026-11-01T01:30:00",
      timeZone: "America/New_York",
    },
    end: {
      dateTime: "2026-11-01T02:30:00",
      timeZone: "America/New_York",
    },
  });
  assert.equal(
    ambiguous.kind === "external_unsupported" ? ambiguous.reason : "",
    "MISSING_RANGE",
  );
});

test("todo el día usa medianoches de Calendar y conserva el fin exclusivo", () => {
  assert.equal(
    googleCalendarDateStart("2026-09-05", "America/Argentina/Buenos_Aires"),
    "2026-09-05T03:00:00.000Z",
  );
  assert.equal(googleCalendarDateStart("2026-02-30", "UTC"), null);
  assert.equal(googleCalendarDateStart("2026-09-05", "Zona/Inexistente"), null);

  const allDay = classifyGoogleCalendarEvent(
    {
      id: "all-day-instance",
      start: { date: "2026-09-05" },
      end: { date: "2026-09-07" },
    },
    "America/Argentina/Buenos_Aires",
  );
  assert.equal(allDay.kind, "external_block");
  if (allDay.kind !== "external_block") return;
  assert.equal(allDay.startsAt, "2026-09-05T03:00:00.000Z");
  assert.equal(allDay.endsAt, "2026-09-07T03:00:00.000Z");
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.recurring, false);
});

test("una ocurrencia expandida conserva su ID aunque sea una excepción movida", () => {
  const event = {
    id: "instance-id-stable",
    recurringEventId: "weekly-master-id",
    originalStartTime: {
      dateTime: "2026-09-08T10:30:00-03:00",
      timeZone: "America/Argentina/Buenos_Aires",
    },
    start: { dateTime: "2026-09-09T11:15:00-03:00" },
    end: { dateTime: "2026-09-09T12:15:00-03:00" },
  };
  const first = classifyGoogleCalendarEvent(
    event,
    "America/Argentina/Buenos_Aires",
  );
  const repeated = classifyGoogleCalendarEvent(
    event,
    "America/Argentina/Buenos_Aires",
  );
  assert.equal(first.kind, "external_block");
  if (first.kind !== "external_block") return;
  assert.equal(first.eventId, "instance-id-stable");
  assert.equal(first.startsAt, "2026-09-09T14:15:00.000Z");
  assert.equal(first.recurring, true);
  assert.equal(first.recurringEventId, "weekly-master-id");
  assert.equal(first.allDay, false);
  assert.deepEqual(repeated, first);
});

test("master recurrente e instancia sin originalStartTime fallan cerrados", () => {
  const recurringMaster = classifyGoogleCalendarEvent(
    {
      id: "master",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      start: { dateTime: "2026-09-04T14:00:00.000Z" },
      end: { dateTime: "2026-09-04T15:00:00.000Z" },
    },
    appointment.timezone,
  );
  const malformedInstance = classifyGoogleCalendarEvent(
    {
      id: "instance",
      recurringEventId: "master",
      start: { dateTime: "2026-09-04T14:00:00.000Z" },
      end: { dateTime: "2026-09-04T15:00:00.000Z" },
    },
    appointment.timezone,
  );
  assert.equal(
    recurringMaster.kind === "external_unsupported"
      ? recurringMaster.reason
      : "",
    "RECURRING",
  );
  assert.equal(
    malformedInstance.kind === "external_unsupported"
      ? malformedInstance.reason
      : "",
    "RECURRING",
  );
});

test("una ocurrencia cancelada conserva el tombstone y no crea bloqueo", () => {
  const cancelled = classifyGoogleCalendarEvent(
    {
      id: "cancelled-instance-id",
      status: "cancelled",
      recurringEventId: "master-id",
      originalStartTime: { dateTime: "2026-09-08T10:30:00-03:00" },
    },
    appointment.timezone,
  );
  assert.equal(cancelled.kind, "external_removed");
  assert.equal(
    cancelled.kind === "external_removed" ? cancelled.removalReason : "",
    "cancelled",
  );
});

test("rango inválido o ausente queda explícitamente no soportado", () => {
  const inverted = classifyGoogleCalendarEvent({
    id: "d",
    start: { dateTime: "2026-09-04T15:00:00.000Z" },
    end: { dateTime: "2026-09-04T14:00:00.000Z" },
  });
  const missing = classifyGoogleCalendarEvent({ id: "e" });
  const unspecifiedEnd = classifyGoogleCalendarEvent({
    id: "f",
    endTimeUnspecified: true,
    start: { dateTime: "2026-09-04T14:00:00.000Z" },
    end: { dateTime: "2026-09-04T15:00:00.000Z" },
  });

  assert.equal(
    inverted.kind === "external_unsupported" ? inverted.reason : "",
    "INVALID_RANGE",
  );
  assert.equal(
    missing.kind === "external_unsupported" ? missing.reason : "",
    "MISSING_RANGE",
  );
  assert.equal(
    unspecifiedEnd.kind === "external_unsupported" ? unspecifiedEnd.reason : "",
    "INVALID_RANGE",
  );
});

test("availability opaque bloquea, transparent libera y valores ambiguos se informan", () => {
  const base = {
    start: { dateTime: "2026-09-04T14:00:00.000Z" },
    end: { dateTime: "2026-09-04T15:00:00.000Z" },
  };
  const opaque = classifyGoogleCalendarEvent({
    ...base,
    id: "opaque",
    transparency: "opaque",
  });
  const transparent = classifyGoogleCalendarEvent({
    ...base,
    id: "transparent",
    transparency: "transparent",
  });
  const ambiguous = classifyGoogleCalendarEvent({
    ...base,
    id: "ambiguous",
    transparency: "future-google-value",
  });

  assert.equal(opaque.kind, "external_block");
  assert.equal(transparent.kind, "external_removed");
  assert.equal(
    transparent.kind === "external_removed" ? transparent.removalReason : "",
    "transparent",
  );
  assert.equal(
    ambiguous.kind === "external_unsupported" ? ambiguous.reason : "",
    "AMBIGUOUS_BUSY_STATE",
  );
});

test("events.list pide showDeleted, pagina y devuelve el sync token", async () => {
  const requested: string[] = [];
  const methods: string[] = [];
  const bodies: Array<BodyInit | null | undefined> = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    requested.push(url);
    methods.push(init?.method ?? "GET");
    bodies.push(init?.body);
    const body = googleEventsPage(
      url.includes("pageToken=page-2")
        ? { items: [{ id: "b" }], nextSyncToken: "sync-token" }
        : { items: [{ id: "a" }], nextPageToken: "page-2" },
    );
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
    calendarTimeZone: appointment.timezone,
    fetcher,
  });
  assert.equal(first.nextPageToken, "page-2");
  assert.equal(first.nextSyncToken, null);

  const second = await listGoogleCalendarEvents({
    accessToken: "token",
    calendarId: "calendar-id",
    calendarTimeZone: appointment.timezone,
    pageToken: first.nextPageToken,
    fetcher,
  });
  assert.equal(second.nextPageToken, null);
  assert.equal(second.nextSyncToken, "sync-token");
  assert.ok(requested[0].includes("showDeleted=true"));
  assert.ok(requested[0].includes("singleEvents=true"));
  assert.equal(
    new URL(requested[0]).searchParams.get("timeZone"),
    appointment.timezone,
  );
  assert.ok(requested[1].includes("pageToken=page-2"));
  assert.deepEqual(methods, ["GET", "GET"]);
  assert.deepEqual(bodies, [undefined, undefined]);
});

test("al paginar una corrida incremental el syncToken viaja en cada página", async () => {
  let requestedUrl = "";
  const fetcher: typeof fetch = (input) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(
        JSON.stringify(googleEventsPage({ items: [], nextSyncToken: "next" })),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };

  await listGoogleCalendarEvents({
    accessToken: "token",
    calendarId: "calendar-id",
    calendarTimeZone: appointment.timezone,
    syncToken: "sync-1",
    pageToken: "page-2",
    fetcher,
  });
  // Google exige el mismo juego de parámetros en todas las páginas.
  assert.ok(requestedUrl.includes("syncToken=sync-1"));
  assert.ok(requestedUrl.includes("pageToken=page-2"));
  assert.equal(new URL(requestedUrl).searchParams.get("timeMin"), null);
});

test("events.list conserva ventana, timezone y tamaño durante un full sync", async () => {
  const requested: URL[] = [];
  const cutoff = "2026-09-04T15:30:00.000Z";
  const horizon = "2027-03-04T15:30:00.000Z";
  const fetcher: typeof fetch = (input) => {
    requested.push(new URL(String(input)));
    return Promise.resolve(
      new Response(
        JSON.stringify(googleEventsPage({ items: [], nextSyncToken: "next" })),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };

  await listGoogleCalendarEvents({
    accessToken: "token",
    calendarId: "calendar-id",
    calendarTimeZone: appointment.timezone,
    timeMin: cutoff,
    timeMax: horizon,
    maxResults: 2500,
    fetcher,
  });
  await listGoogleCalendarEvents({
    accessToken: "token",
    calendarId: "calendar-id",
    calendarTimeZone: appointment.timezone,
    timeMin: cutoff,
    timeMax: horizon,
    pageToken: "page-2",
    maxResults: 2500,
    fetcher,
  });

  assert.equal(requested.length, 2);
  for (const url of requested) {
    assert.equal(url.searchParams.get("timeMin"), cutoff);
    assert.equal(url.searchParams.get("timeMax"), horizon);
    assert.equal(url.searchParams.get("maxResults"), "2500");
    assert.equal(url.searchParams.get("singleEvents"), "true");
    assert.equal(url.searchParams.get("showDeleted"), "true");
    assert.equal(url.searchParams.get("timeZone"), appointment.timezone);
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
        calendarTimeZone: appointment.timezone,
        syncToken: "sync-1",
        timeMin: "2026-09-04T15:30:00.000Z",
        fetcher,
      }),
    (error: unknown) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENTS_LIST_PARAMETERS_INVALID" &&
      error.status === 400,
  );
  await assert.rejects(
    () =>
      listGoogleCalendarEvents({
        accessToken: "token",
        calendarId: "calendar-id",
        calendarTimeZone: appointment.timezone,
        timeMax: "2026-02-30T15:30:00.000Z",
        fetcher,
      }),
    (error: unknown) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENTS_LIST_PARAMETERS_INVALID" &&
      error.status === 400,
  );
  assert.equal(fetches, 0);
});

test("events.list rechaza timeMax con syncToken y timezone inválida sin leer", async () => {
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
        calendarTimeZone: appointment.timezone,
        syncToken: "sync-1",
        timeMax: "2027-03-04T15:30:00.000Z",
        fetcher,
      }),
    (error: unknown) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENTS_LIST_PARAMETERS_INVALID" &&
      error.status === 400,
  );
  await assert.rejects(
    () =>
      listGoogleCalendarEvents({
        accessToken: "token",
        calendarId: "calendar-id",
        calendarTimeZone: "Zona/Inexistente",
        fetcher,
      }),
    (error: unknown) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENTS_LIST_PARAMETERS_INVALID" &&
      error.status === 400,
  );
  assert.equal(fetches, 0);
});

test("events.list rechaza una ventana vacía antes de usar Google", async () => {
  let fetches = 0;
  await assert.rejects(
    () =>
      listGoogleCalendarEvents({
        accessToken: "token",
        calendarId: "calendar-id",
        calendarTimeZone: appointment.timezone,
        timeMin: "2026-09-05T15:30:00.000Z",
        timeMax: "2026-09-05T15:30:00.000Z",
        fetcher: (() => {
          fetches += 1;
          return Promise.resolve(new Response("{}"));
        }) as typeof fetch,
      }),
    (error: unknown) =>
      error instanceof GoogleIntegrationError &&
      error.code === "GOOGLE_EVENTS_LIST_PARAMETERS_INVALID",
  );
  assert.equal(fetches, 0);
});

test("events.list no interpreta una respuesta malformada como calendario vacío", async () => {
  for (const body of [
    [],
    { items: { dato: "inválido" }, nextSyncToken: "token-inválido" },
    { items: [null], nextSyncToken: "token-inválido" },
    { items: ["evento-inválido"], nextSyncToken: "token-inválido" },
    { items: [{ status: "confirmed" }], nextSyncToken: "token-inválido" },
    { items: [], nextPageToken: { página: 2 } },
    googleEventsPage({ items: [] }),
    googleEventsPage({
      items: [],
      nextPageToken: "página-siguiente",
      nextSyncToken: "sync-siguiente",
    }),
  ]) {
    await assert.rejects(
      () =>
        listGoogleCalendarEvents({
          accessToken: "token",
          calendarId: "calendar-id",
          calendarTimeZone: appointment.timezone,
          fetcher: (() => Promise.resolve(Response.json(body))) as typeof fetch,
        }),
      (error: unknown) =>
        error instanceof GoogleIntegrationError &&
        error.code === "GOOGLE_EVENTS_LIST_INVALID" &&
        error.retryable,
    );
  }
});

test("events.list falla cerrado si Google contradice calendario o permisos", async () => {
  for (const body of [
    {
      kind: "calendar#events",
      items: [],
      accessRole: "owner",
      nextSyncToken: "scope-incompleto",
    },
    {
      kind: "calendar#events",
      items: [],
      timeZone: "America/Montevideo",
      accessRole: "owner",
      nextSyncToken: "scope-token",
    },
    {
      kind: "calendar#events",
      items: [],
      timeZone: appointment.timezone,
      accessRole: "reader",
      nextSyncToken: "scope-token",
    },
  ]) {
    await assert.rejects(
      () =>
        listGoogleCalendarEvents({
          accessToken: "token",
          calendarId: "calendar-id",
          calendarTimeZone: appointment.timezone,
          fetcher: (() => Promise.resolve(Response.json(body))) as typeof fetch,
        }),
      (error: unknown) =>
        error instanceof GoogleIntegrationError &&
        error.code === "GOOGLE_EVENTS_LIST_SCOPE_MISMATCH" &&
        error.status === 409,
    );
  }
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
        calendarTimeZone: appointment.timezone,
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
