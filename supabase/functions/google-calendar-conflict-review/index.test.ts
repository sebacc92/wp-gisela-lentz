import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import type { GoogleCalendarEvent } from "../_shared/google-calendar.ts";
import {
  handleGoogleCalendarConflictReviewRequest,
  titleReviewBlockReason,
  type ConflictReviewDependencies,
  type ReviewContext,
} from "./index.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const EPOCH = "33333333-3333-4333-8333-333333333333";
const UPDATED = "2026-09-08T00:00:00.000Z";
const START = "2026-09-09T17:00:00.000Z";
const END = "2026-09-09T17:30:00.000Z";
const SECRET = "server-secret-for-unit-tests-only";
const ENV: Record<string, string> = {
  GOOGLE_CALENDAR_CLIENT_ID: "test-client",
  GOOGLE_CALENDAR_CLIENT_SECRET: "oauth-secret-not-for-browser",
  GOOGLE_CALENDAR_REDIRECT_URI: "https://app.example.com/callback",
  APP_BASE_URL: "https://app.example.com",
};

function context(): ReviewContext {
  return {
    conflict: {
      id: ID,
      appointment_id: ID,
      google_event_id: "event-id",
      kind: "metadata_changed",
      status: "pending",
      connection_generation: 5,
      updated_at: UPDATED,
    },
    appointment: {
      id: ID,
      contact_id: ID,
      starts_at: START,
      ends_at: END,
      status: "confirmed",
      coverage: "particular",
      google_calendar_imported: true,
      updated_at: UPDATED,
    },
    contact: {
      id: ID,
      name: "Matías Ejemplo",
      phone_e164: "+5492235550123",
      alternate_phone_e164: null,
      is_existing_patient: true,
      updated_at: UPDATED,
    },
    source: {
      google_event_id: "event-id",
      google_calendar_id: "calendar@example.com",
      connection_generation: 5,
      converted_appointment_id: ID,
      summary: "Matias Ejemplo tf particular",
      status: "converted",
      kind: "block",
      starts_at: START,
      ends_at: END,
      all_day: false,
      recurring: false,
      removed_at: null,
      google_etag: '"old-version"',
      google_updated_at: UPDATED,
    },
    connection: {
      status: "connected",
      google_account_id: "google-account",
      google_calendar_id: "calendar@example.com",
      connection_generation: 5,
      automation_enabled: true,
      automation_epoch: EPOCH,
      automation_google_account_id: "google-account",
      automation_google_calendar_id: "calendar@example.com",
      automation_connection_generation: 5,
      sync_scope_google_account_id: "google-account",
      sync_scope_google_calendar_id: "calendar@example.com",
      sync_scope_generation: 5,
    },
  };
}

function event(): GoogleCalendarEvent {
  return {
    id: "event-id",
    summary: "EJEMPLO Matías · TF · Particular",
    status: "confirmed",
    etag: '"reviewed-version"',
    updated: UPDATED,
    start: { dateTime: START },
    end: { dateTime: END },
  };
}

function request(
  action = "review",
  reviewToken?: string,
  bearer = "user-token",
) {
  return new Request("https://app.example.com/review", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action,
      conflictId: ID,
      ...(reviewToken ? { reviewToken } : {}),
    }),
  });
}

function fixture() {
  const value = context();
  let remote = event();
  let acceptedError: { message: string } | null = null;
  const writes: Record<string, unknown>[] = [];
  const methods: string[] = [];
  let reads = 0;
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "get_google_calendar_windowed_connection_secret")
        return Promise.resolve({
          error: null,
          data: [
            {
              status: "connected",
              google_calendar_id: value.connection.google_calendar_id,
              connection_generation: 5,
              refresh_token: "private-refresh-token",
            },
          ],
        });
      assert.equal(name, "accept_google_calendar_imported_title_review");
      writes.push(args);
      return Promise.resolve({
        data: { status: "applied" },
        error: acceptedError,
      });
    },
  } as unknown as SupabaseClient;
  const dependencies: ConflictReviewDependencies = {
    createClient: () => client,
    serviceKey: () => SECRET,
    authorize: async () =>
      ({
        user: { id: ACTOR },
        profile: { id: ACTOR, full_name: "Admin", role: "ADMIN" },
      }) as Awaited<
        ReturnType<NonNullable<ConflictReviewDependencies["authorize"]>>
      >,
    environment: (name) => ENV[name],
    loadContext: async () => {
      reads++;
      return structuredClone(value);
    },
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      methods.push(`${url.hostname} ${init?.method}`);
      if (url.hostname === "oauth2.googleapis.com") {
        assert.equal(init?.method, "POST");
        return Response.json({ access_token: "private-access-token" });
      }
      assert.equal(url.hostname, "www.googleapis.com");
      assert.equal(
        url.pathname,
        "/calendar/v3/calendars/calendar%40example.com/events/event-id",
      );
      assert.equal(init?.method, "GET");
      return Response.json(remote);
    },
  };
  return {
    dependencies,
    value,
    writes,
    methods,
    get reads() {
      return reads;
    },
    setRemote: (value: GoogleCalendarEvent) => {
      remote = value;
    },
    failAcceptance: () => {
      acceptedError = { message: "CALENDAR_REVIEW_BUSY" };
    },
  };
}

Deno.test(
  "review shows only the linked event comparison, makes no database or Google mutations",
  async () => {
    const test = fixture();
    const response = await handleGoogleCalendarConflictReviewRequest(
      request(),
      test.dependencies,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.local.title, test.value.source.summary);
    assert.equal(body.remote.title, event().summary);
    assert.equal(body.canAcceptTitle, true);
    assert.match(body.reviewToken, /^[0-9a-f]{64}$/);
    assert.equal(body.reason, null);
    assert.equal(test.writes.length, 0);
    assert.equal(test.reads, 2);
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      SECRET,
      "private-refresh",
      "private-access",
      "oauth-secret",
      "calendar@example.com",
      "google-account",
      '"etag"',
      "description",
    ])
      assert.equal(serialized.includes(forbidden), false);
    assert.deepEqual(test.methods, [
      "oauth2.googleapis.com POST",
      "www.googleapis.com GET",
    ]);
  },
);

Deno.test(
  "explicit acceptance refreshes Google, binds administrator/snapshots and only updates review baseline",
  async () => {
    const test = fixture();
    const preview = await (
      await handleGoogleCalendarConflictReviewRequest(
        request(),
        test.dependencies,
      )
    ).json();
    const response = await handleGoogleCalendarConflictReviewRequest(
      request("accept_title", preview.reviewToken),
      test.dependencies,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { resolved: true });
    assert.equal(test.writes.length, 1);
    assert.equal(test.writes[0].p_actor_id, ACTOR);
    assert.equal(test.writes[0].p_expected_summary, test.value.source.summary);
    assert.equal(test.writes[0].p_reviewed_summary, event().summary);
    assert.equal(test.writes[0].p_expected_google_etag, '"old-version"');
    assert.equal(test.writes[0].p_reviewed_google_etag, '"reviewed-version"');
    assert.equal(test.writes[0].p_expected_contact_updated_at, UPDATED);
    assert.equal(
      test.methods.filter((value) => value === "www.googleapis.com GET").length,
      2,
    );
  },
);

for (const mutation of [
  (e: GoogleCalendarEvent) => {
    e.etag = '"new-etag"';
  },
  (e: GoogleCalendarEvent) => {
    e.summary = "Otra Persona TF Particular";
  },
  (e: GoogleCalendarEvent) => {
    e.start = { dateTime: "2026-09-09T18:00:00Z" };
  },
  (e: GoogleCalendarEvent) => {
    e.status = "cancelled";
  },
]) {
  Deno.test(
    `changed remote snapshot cannot reuse reviewed token: ${mutation.toString()}`,
    async () => {
      const test = fixture();
      const preview = await (
        await handleGoogleCalendarConflictReviewRequest(
          request(),
          test.dependencies,
        )
      ).json();
      const changed = event();
      mutation(changed);
      test.setRemote(changed);
      const response = await handleGoogleCalendarConflictReviewRequest(
        request("accept_title", preview.reviewToken),
        test.dependencies,
      );
      assert.equal(response.status, 409);
      assert.equal(test.writes.length, 0);
    },
  );
}

Deno.test(
  "service diagnostics can read but cannot produce or accept an administrator decision",
  async () => {
    const test = fixture();
    test.dependencies.authorize = async () => {
      throw new Error("must not impersonate an admin");
    };
    const response = await handleGoogleCalendarConflictReviewRequest(
      request("review", undefined, SECRET),
      test.dependencies,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.reviewToken, "");
    assert.equal(body.canAcceptTitle, false);
    const accepted = await handleGoogleCalendarConflictReviewRequest(
      request("accept_title", "0".repeat(64), SECRET),
      test.dependencies,
    );
    assert.equal(accepted.status, 403);
    assert.equal(test.writes.length, 0);
  },
);

Deno.test(
  "anonymous, invalid and operator callers cannot read Calendar",
  async () => {
    for (const role of ["invalid", "OPERADOR"]) {
      const test = fixture();
      test.dependencies.authorize = async () => {
        if (role === "invalid") throw new Error("UNAUTHORIZED");
        return {
          user: { id: ACTOR },
          profile: { id: ACTOR, role: "OPERADOR" },
        } as Awaited<
          ReturnType<NonNullable<ConflictReviewDependencies["authorize"]>>
        >;
      };
      const response = await handleGoogleCalendarConflictReviewRequest(
        request(),
        test.dependencies,
      );
      assert.equal(response.status, role === "invalid" ? 401 : 403);
      assert.equal(test.reads, 0);
      assert.equal(test.methods.length, 0);
      assert.equal(test.writes.length, 0);
    }
  },
);

Deno.test(
  "scope, local baseline or contact edits invalidate the review",
  async () => {
    for (const change of [
      (c: ReviewContext) => {
        c.connection.automation_epoch = ID;
      },
      (c: ReviewContext) => {
        c.contact.updated_at = "2026-09-08T01:00:00Z";
      },
      (c: ReviewContext) => {
        c.source.summary = "Matias Ejemplo TF Particular consulta";
      },
      (c: ReviewContext) => {
        c.conflict.status = "applied";
      },
    ]) {
      const test = fixture();
      const preview = await (
        await handleGoogleCalendarConflictReviewRequest(
          request(),
          test.dependencies,
        )
      ).json();
      change(test.value);
      const response = await handleGoogleCalendarConflictReviewRequest(
        request("accept_title", preview.reviewToken),
        test.dependencies,
      );
      assert.equal(response.status, 409);
      assert.equal(test.writes.length, 0);
    }
  },
);

Deno.test(
  "OAuth/network failure does not mutate connection or leak upstream details",
  async () => {
    const test = fixture();
    test.dependencies.fetcher = async () =>
      Response.json({ error: "private-refresh-token" }, { status: 401 });
    const response = await handleGoogleCalendarConflictReviewRequest(
      request(),
      test.dependencies,
    );
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("private-refresh"), false);
    assert.equal(test.writes.length, 0);
  },
);

Deno.test("SQL stale/busy acceptance cannot report success", async () => {
  const test = fixture();
  const preview = await (
    await handleGoogleCalendarConflictReviewRequest(
      request(),
      test.dependencies,
    )
  ).json();
  test.failAcceptance();
  const response = await handleGoogleCalendarConflictReviewRequest(
    request("accept_title", preview.reviewToken),
    test.dependencies,
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "CALENDAR_REVIEW_BUSY");
});

Deno.test(
  "harmless accents, order, capitalization and known phone can be reviewed",
  () => {
    for (const title of [
      "Matías Ejemplo TF Particular",
      "EJEMPLO MATIAS tf particular",
      "Matias Ejemplo TF +5492235550123 Particular",
    ]) {
      assert.equal(
        titleReviewBlockReason(context(), { ...event(), summary: title }),
        null,
      );
    }
  },
);

Deno.test(
  "ambiguous or meaningful changes never qualify for text-only acceptance",
  () => {
    const cases: GoogleCalendarEvent[] = [
      ...[
        "Otra Persona TF Particular",
        "Matias Ejemplo TF IOMA",
        "Matias Ejemplo 1ra vez Particular",
        "Matias Ejemplo TF Particular limpieza",
        "Matias Ejemplo TF Particular cancelado",
        "Matias Ejemplo TF Particular +5492235550999",
        "Matias Ejemplo TF Particular " + "x".repeat(130),
      ].map((summary) => ({ ...event(), summary })),
      { ...event(), status: "cancelled" },
      { ...event(), transparency: "transparent" },
      { ...event(), recurrence: ["RRULE:FREQ=WEEKLY"] },
      { ...event(), start: { date: "2026-09-09" } },
      { ...event(), endTimeUnspecified: true },
      { ...event(), etag: undefined },
      { ...event(), end: { dateTime: "2026-09-09T18:00:00Z" } },
    ];
    for (const remote of cases)
      assert.equal(typeof titleReviewBlockReason(context(), remote), "string");
  },
);

Deno.test(
  "JSON property ordering alone never invalidates a reviewed Google version",
  async () => {
    const test = fixture();
    const preview = await (
      await handleGoogleCalendarConflictReviewRequest(
        request(),
        test.dependencies,
      )
    ).json();
    test.setRemote(Object.fromEntries(Object.entries(event()).reverse()));
    const response = await handleGoogleCalendarConflictReviewRequest(
      request("accept_title", preview.reviewToken),
      test.dependencies,
    );
    assert.equal(response.status, 200);
    assert.equal(test.writes[0].p_expected_automation_epoch, EPOCH);
  },
);

Deno.test("another administrator cannot reuse the review token", async () => {
  const test = fixture();
  const preview = await (
    await handleGoogleCalendarConflictReviewRequest(
      request(),
      test.dependencies,
    )
  ).json();
  test.dependencies.authorize = async () =>
    ({ user: { id: ID }, profile: { id: ID, role: "ADMIN" } }) as Awaited<
      ReturnType<NonNullable<ConflictReviewDependencies["authorize"]>>
    >;
  const response = await handleGoogleCalendarConflictReviewRequest(
    request("accept_title", preview.reviewToken),
    test.dependencies,
  );
  assert.equal(response.status, 409);
  assert.equal(test.writes.length, 0);
});

Deno.test(
  "local source changes during the remote lookup require a fresh review",
  async () => {
    const test = fixture();
    let reads = 0;
    test.dependencies.loadContext = async () => {
      const value = structuredClone(test.value);
      if (++reads > 1) value.source.google_etag = '"new-local-observation"';
      return value;
    };
    const response = await handleGoogleCalendarConflictReviewRequest(
      request(),
      test.dependencies,
    );
    assert.equal(response.status, 409);
    assert.equal(test.writes.length, 0);
  },
);

Deno.test(
  "lost ADMIN permission before acceptance prevents the SQL mutation",
  async () => {
    const test = fixture();
    const preview = await (
      await handleGoogleCalendarConflictReviewRequest(
        request(),
        test.dependencies,
      )
    ).json();
    const original = test.dependencies.authorize!;
    let checks = 0;
    test.dependencies.authorize = async (...args) => {
      if (++checks > 1) throw new Error("UNAUTHORIZED");
      return original(...args);
    };
    const response = await handleGoogleCalendarConflictReviewRequest(
      request("accept_title", preview.reviewToken),
      test.dependencies,
    );
    assert.equal(response.status, 401);
    assert.equal(test.writes.length, 0);
  },
);

Deno.test(
  "missing and deleted remote events never resolve or mutate anything",
  async () => {
    for (const status of [404, 410]) {
      const test = fixture();
      const original = test.dependencies.fetcher!;
      test.dependencies.fetcher = async (input, init) =>
        String(input).includes("www.googleapis.com")
          ? new Response(null, { status })
          : original(input, init);
      const response = await handleGoogleCalendarConflictReviewRequest(
        request(),
        test.dependencies,
      );
      assert.equal(response.status, 409);
      assert.equal(test.writes.length, 0);
    }
  },
);

Deno.test(
  "unverified local ETag and unknown transparency cannot be accepted",
  () => {
    const noEtag = context();
    noEtag.source.google_etag = null;
    assert.equal(typeof titleReviewBlockReason(noEtag, event()), "string");
    assert.equal(
      typeof titleReviewBlockReason(context(), {
        ...event(),
        transparency: "unknown",
      }),
      "string",
    );
  },
);

Deno.test(
  "an explicit review can preserve a deposit annotation as text without parsing or recording money",
  async () => {
    for (const suffix of [
      "seña 10",
      "seña $10.000",
      "SEÑA 10 mil",
      "seña 10k",
      "seña 10000 pesos",
    ]) {
      const test = fixture();
      const title = `Matias Ejemplo TF Particular ${suffix}`;
      test.setRemote({ ...event(), summary: title });
      const preview = await (
        await handleGoogleCalendarConflictReviewRequest(
          request(),
          test.dependencies,
        )
      ).json();
      assert.equal(preview.canAcceptTitle, true);
      assert.equal(preview.remote.title, title);
      const accepted = await handleGoogleCalendarConflictReviewRequest(
        request("accept_title", preview.reviewToken),
        test.dependencies,
      );
      assert.equal(accepted.status, 200);
      assert.equal(test.writes.length, 1);
      assert.equal(test.writes[0].p_reviewed_summary, title);
      assert.equal(
        Object.keys(test.writes[0]).some((key) =>
          /payment|deposit|amount/.test(key),
        ),
        false,
      );
    }
  },
);

Deno.test(
  "a deposit annotation cannot mask another patient, cancellation, phone or an ambiguous note",
  () => {
    for (const summary of [
      "Otra Persona TF Particular seña 10",
      "Matias Ejemplo TF Particular cancelado seña 10",
      "Matias Ejemplo TF Particular +5492235550999 seña 10",
      "Matias Ejemplo TF Particular seña pendiente",
      "Matias Ejemplo TF Particular seña 10 o 20",
      "Matias Ejemplo TF Particular seña 10 otra persona",
      "Matias Ejemplo TF Particular seña 2235550123",
      "Matias Ejemplo TF Particular seña 0",
      "Matias Ejemplo TF Particular sin seña 10",
      "Matias Ejemplo TF Particular pendiente de seña 10",
      "Matias Ejemplo TF Particular seña 10 seña 20",
      "Matias Ejemplo TF Particular seña -10",
    ]) {
      assert.equal(
        typeof titleReviewBlockReason(context(), { ...event(), summary }),
        "string",
      );
    }
    const reviewed = context();
    reviewed.source.summary = "Matias Ejemplo TF Particular seña 10";
    assert.equal(
      titleReviewBlockReason(reviewed, {
        ...event(),
        summary: "Matias Ejemplo TF Particular seña 20",
      }),
      null,
    );
  },
);

Deno.test(
  "missing token, unknown actions and browser-supplied calendar overrides fail before Google",
  async () => {
    for (const body of [
      { action: "accept_title", conflictId: ID },
      { action: "delete", conflictId: ID },
      { action: "review", conflictId: ID, calendarId: "unrelated-calendar" },
      { action: "review", conflictId: "not-a-uuid" },
    ]) {
      const test = fixture();
      const input = new Request("https://app.example.com/review", {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
        body: JSON.stringify(body),
      });
      const response = await handleGoogleCalendarConflictReviewRequest(
        input,
        test.dependencies,
      );
      assert.ok(response.status >= 400);
      assert.equal(test.reads, 0);
      assert.equal(test.methods.length, 0);
      assert.equal(test.writes.length, 0);
    }
  },
);
