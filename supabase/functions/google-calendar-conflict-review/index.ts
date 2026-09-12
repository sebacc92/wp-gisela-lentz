import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  getGoogleCalendarEvent,
  GoogleIntegrationError,
  googleOAuthConfiguration,
  refreshGoogleAccessToken,
  type GoogleCalendarEvent,
} from "../_shared/google-calendar.ts";
import {
  calendarPatientNameKey,
  parseCalendarPatientTitle,
} from "../_shared/calendar-patient-title.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import {
  authorizeUser,
  createServiceClient,
  getServiceKey,
} from "../_shared/supabase.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReviewContext {
  conflict: {
    id: string;
    appointment_id: string;
    google_event_id: string;
    kind: string;
    status: string;
    connection_generation: number;
    updated_at: string;
  };
  appointment: {
    id: string;
    contact_id: string;
    starts_at: string;
    ends_at: string;
    status: string;
    coverage: string | null;
    google_calendar_imported: boolean;
    updated_at: string;
  };
  contact: {
    id: string;
    name: string;
    phone_e164: string | null;
    alternate_phone_e164: string | null;
    is_existing_patient: boolean | null;
    updated_at: string;
  };
  source: {
    google_event_id: string;
    google_calendar_id: string;
    connection_generation: number;
    converted_appointment_id: string;
    summary: string | null;
    status: string;
    kind: string;
    starts_at: string | null;
    ends_at: string | null;
    all_day: boolean;
    recurring: boolean;
    removed_at: string | null;
    google_etag: string | null;
    google_updated_at: string | null;
  };
  connection: {
    status: string;
    google_account_id: string;
    google_calendar_id: string;
    connection_generation: number;
    automation_enabled: boolean;
    automation_epoch: string | null;
    automation_google_account_id: string | null;
    automation_google_calendar_id: string | null;
    automation_connection_generation: number | null;
    sync_scope_google_account_id: string | null;
    sync_scope_google_calendar_id: string | null;
    sync_scope_generation: number | null;
  };
}

export interface ConflictReviewDependencies {
  createClient?: () => SupabaseClient;
  authorize?: typeof authorizeUser;
  environment?: (name: string) => string | undefined;
  serviceKey?: () => string;
  fetcher?: typeof fetch;
  loadContext?: typeof loadReviewContext;
}

class ReviewError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}

function first<T>(value: T | T[]): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function loadReviewContext(
  client: SupabaseClient,
  id: string,
): Promise<ReviewContext> {
  const conflictResult = await client
    .from("google_calendar_sync_conflicts")
    .select(
      "id,appointment_id,google_event_id,kind,status,connection_generation,updated_at",
    )
    .eq("id", id)
    .single();
  if (conflictResult.error || !conflictResult.data)
    throw new ReviewError("CALENDAR_REVIEW_NOT_FOUND", 404);
  const conflict = conflictResult.data as ReviewContext["conflict"];
  const appointmentResult = await client
    .from("appointments")
    .select(
      "id,contact_id,starts_at,ends_at,status,coverage,google_calendar_imported,updated_at",
    )
    .eq("id", conflict.appointment_id)
    .single();
  if (appointmentResult.error || !appointmentResult.data)
    throw new ReviewError("CALENDAR_REVIEW_STALE");
  const appointment = appointmentResult.data as ReviewContext["appointment"];
  const [contactResult, sourceResult, connectionResult] = await Promise.all([
    client
      .from("contacts")
      .select(
        "id,name,phone_e164,alternate_phone_e164,is_existing_patient,updated_at",
      )
      .eq("id", appointment.contact_id)
      .single(),
    client
      .from("google_calendar_external_events")
      .select(
        "google_event_id,google_calendar_id,connection_generation,converted_appointment_id,summary,status,kind,starts_at,ends_at,all_day,recurring,removed_at,google_etag,google_updated_at",
      )
      .eq("converted_appointment_id", appointment.id)
      .eq("google_event_id", conflict.google_event_id)
      .eq("connection_generation", conflict.connection_generation)
      .single(),
    client
      .from("google_calendar_connections")
      .select(
        "status,google_account_id,google_calendar_id,connection_generation,automation_enabled,automation_epoch,automation_google_account_id,automation_google_calendar_id,automation_connection_generation,sync_scope_google_account_id,sync_scope_google_calendar_id,sync_scope_generation",
      )
      .eq("id", true)
      .single(),
  ]);
  if (
    contactResult.error ||
    sourceResult.error ||
    connectionResult.error ||
    !contactResult.data ||
    !sourceResult.data ||
    !connectionResult.data
  ) {
    throw new ReviewError("CALENDAR_REVIEW_STALE");
  }
  return {
    conflict,
    appointment,
    contact: contactResult.data,
    source: sourceResult.data,
    connection: connectionResult.data,
  } as ReviewContext;
}

function assertContext(context: ReviewContext): void {
  const {
    conflict: c,
    appointment: a,
    source: s,
    connection: n,
    contact,
  } = context;
  if (
    c.status !== "pending" ||
    c.kind !== "metadata_changed" ||
    a.google_calendar_imported !== true ||
    a.status !== "confirmed" ||
    a.id !== c.appointment_id ||
    contact.id !== a.contact_id ||
    s.converted_appointment_id !== a.id ||
    s.google_event_id !== c.google_event_id ||
    s.status !== "converted" ||
    s.google_calendar_id !== n.google_calendar_id ||
    s.connection_generation !== c.connection_generation ||
    c.connection_generation !== n.connection_generation ||
    n.status !== "connected" ||
    !n.automation_enabled ||
    !n.automation_epoch ||
    n.automation_google_account_id !== n.google_account_id ||
    n.automation_google_calendar_id !== n.google_calendar_id ||
    n.automation_connection_generation !== n.connection_generation ||
    n.sync_scope_google_account_id !== n.google_account_id ||
    n.sync_scope_google_calendar_id !== n.google_calendar_id ||
    n.sync_scope_generation !== n.connection_generation
  )
    throw new ReviewError("CALENDAR_REVIEW_STALE");
}

function instant(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  return new Date(value).toISOString();
}

/** Keep a trailing administrative annotation in the title, not in the name.
 * This does NOT interpret a monetary value, register payment or confirm a
 * deposit. This tolerance is deliberately NOT used by automatic imports. */
function identityTitle(value: string | null): string | null {
  return (
    value
      ?.trim()
      .replace(
        /\s+se[nñ]a\s+\$?\s*[1-9]\d{0,6}(?:[.,]\d{1,3})*(?:\s*(?:mil|k|pesos|ars))?$/iu,
        "",
      )
      .trim() ?? null
  );
}

/** Accept only a harmless title change, never infer a patient reassignment or
 * a change of time, coverage, phone, clinical service or attendance. */
export function titleReviewBlockReason(
  context: ReviewContext,
  event: GoogleCalendarEvent,
): string | null {
  const { appointment, contact, source } = context;
  if (
    event.status !== "confirmed" ||
    (event.transparency !== undefined && event.transparency !== "opaque")
  ) {
    return "El evento ya no figura como un turno ocupado en Google. No se puede resolver como un cambio de texto.";
  }
  if (
    event.start?.date ||
    event.end?.date ||
    event.recurringEventId ||
    event.recurrence?.length ||
    event.originalStartTime ||
    event.endTimeUnspecified ||
    (event.eventType !== undefined && event.eventType !== "default")
  ) {
    return "El evento cambió de formato o repetición. Necesita una revisión adicional; el turno sigue intacto.";
  }
  if (
    instant(event.start?.dateTime) !== instant(appointment.starts_at) ||
    instant(event.end?.dateTime) !== instant(appointment.ends_at)
  ) {
    return "También cambió el horario en Google. Sincronizá y revisá la propuesta de horario antes de aceptar.";
  }
  if (
    !source.google_etag?.trim() ||
    source.google_etag.length > 255 ||
    source.removed_at ||
    source.all_day ||
    source.recurring ||
    source.kind !== "block" ||
    instant(source.starts_at) !== instant(appointment.starts_at) ||
    instant(source.ends_at) !== instant(appointment.ends_at)
  ) {
    return "La última observación no coincide con el turno. Sincronizá y volvé a revisar el cambio.";
  }
  if (
    typeof event.etag !== "string" ||
    !event.etag.trim() ||
    event.etag.length > 255 ||
    !instant(event.updated)
  ) {
    return "Google no devolvió una versión verificable del evento. Volvé a revisar en unos minutos.";
  }
  const title = typeof event.summary === "string" ? event.summary.trim() : "";
  if (!title || title.length > 120 || /[\u0000-\u001f\u007f]/.test(title)) {
    return "El título está vacío, es demasiado largo o tiene un formato que no podemos validar con seguridad.";
  }
  const baseline = parseCalendarPatientTitle(identityTitle(source.summary));
  const remote = parseCalendarPatientTitle(identityTitle(title));
  // The importer reads the name from the text before the first known marker, so
  // a trailing work note never reaches it. Accepting a title is stricter: every
  // word has to be either a recognized marker or the patient's name. Whatever is
  // left over is an annotation we did not understand, and a deposit note that
  // this review does not strip verbatim is exactly that.
  const identifiesContact = (hints: typeof remote): boolean =>
    Boolean(hints.name) &&
    calendarPatientNameKey(hints.name) ===
      calendarPatientNameKey(contact.name) &&
    calendarPatientNameKey(hints.rawName) ===
      calendarPatientNameKey(contact.name);
  if (
    !remote.isPatientCandidate ||
    remote.uncertainties.length ||
    baseline.uncertainties.length ||
    !identifiesContact(remote) ||
    !identifiesContact(baseline)
  ) {
    return "El texto no identifica con seguridad al mismo paciente. No vamos a cambiar el paciente ni descartar esta diferencia automáticamente.";
  }
  // Compare the event's own baseline for TF/first visit. The contact's global
  // flag may differ already; this text-only review must neither change it nor
  // claim that a pre-existing discrepancy has been verified or corrected.
  if (
    !remote.coverage ||
    remote.coverage !== appointment.coverage ||
    remote.coverage !== baseline.coverage ||
    remote.isExistingPatient === null ||
    remote.isExistingPatient !== baseline.isExistingPatient ||
    remote.serviceHint !== baseline.serviceHint ||
    remote.orthodonticVisitType !== baseline.orthodonticVisitType
  ) {
    return "Cambió o falta un dato del turno, la cobertura o la ficha. No se puede aceptar sólo como un cambio de texto.";
  }
  const knownPhones = [contact.phone_e164, contact.alternate_phone_e164].filter(
    Boolean,
  );
  if (
    (remote.phoneE164 && !knownPhones.includes(remote.phoneE164)) ||
    (baseline.phoneE164 && remote.phoneE164 !== baseline.phoneE164)
  ) {
    return "Cambió el teléfono del título y no coincide con los datos conocidos del paciente. Necesita revisión adicional.";
  }
  return null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sameSecret(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const a = await digest(left),
    b = await digest(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function handleGoogleCalendarConflictReviewRequest(
  request: Request,
  dependencies: ConflictReviewDependencies = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST")
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const client = (dependencies.createClient ?? createServiceClient)();
    const bearer = (request.headers.get("authorization") ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const service = await sameSecret(
      bearer,
      (dependencies.serviceKey ?? getServiceKey)(),
    );
    // Service credentials may diagnose a single conflict but cannot make a
    // patient's review decision. Accept always requires a real active ADMIN.
    let actorId = "service-diagnostic";
    if (!service) {
      const authorization = await (dependencies.authorize ?? authorizeUser)(
        request,
        client,
      );
      if (authorization.profile.role !== "ADMIN")
        throw new ReviewError("ADMIN_REQUIRED", 403);
      actorId = authorization.user.id;
    }
    const rawBody = await request.text();
    if (rawBody.length > 2048) throw new ReviewError("INVALID_REQUEST", 400);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new ReviewError("INVALID_REQUEST", 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !["review", "accept_title"].includes(String(body.action)) ||
      typeof body.conflictId !== "string" ||
      !UUID.test(body.conflictId) ||
      Object.keys(body).some(
        (key) => !["action", "conflictId", "reviewToken"].includes(key),
      )
    )
      throw new ReviewError("INVALID_REQUEST", 400);
    if (service && body.action !== "review")
      throw new ReviewError("ADMIN_REQUIRED", 403);
    if (
      body.action === "accept_title" &&
      (typeof body.reviewToken !== "string" ||
        !/^[0-9a-f]{64}$/.test(body.reviewToken))
    ) {
      throw new ReviewError("CALENDAR_REVIEW_STALE");
    }
    const readContext = dependencies.loadContext ?? loadReviewContext;
    const context = await readContext(client, body.conflictId);
    assertContext(context);
    const { data, error } = await client.rpc(
      "get_google_calendar_windowed_connection_secret",
      {},
    );
    const secret = first(data) as
      | {
          status?: string;
          google_calendar_id?: string;
          connection_generation?: number;
          refresh_token?: string;
        }
      | undefined;
    if (
      error ||
      !secret?.refresh_token ||
      secret.status !== "connected" ||
      secret.google_calendar_id !== context.connection.google_calendar_id ||
      secret.connection_generation !== context.connection.connection_generation
    )
      throw new ReviewError("CALENDAR_REVIEW_STALE");
    const config = googleOAuthConfiguration(
      dependencies.environment ?? ((name) => Deno.env.get(name)),
    );
    const token = await refreshGoogleAccessToken({
      refreshToken: secret.refresh_token,
      config,
      fetcher: dependencies.fetcher,
    });
    const lookup = await getGoogleCalendarEvent({
      accessToken: token.access_token,
      calendarId: context.connection.google_calendar_id,
      eventId: context.conflict.google_event_id,
      fetcher: dependencies.fetcher,
    });
    // No reconnect markers, sync runs or other writes on this read path.
    const refreshed = await readContext(client, body.conflictId);
    assertContext(refreshed);
    if ((await digest(context)) !== (await digest(refreshed)))
      throw new ReviewError("CALENDAR_REVIEW_STALE");
    if (lookup.kind !== "found")
      throw new ReviewError("CALENDAR_EVENT_UNAVAILABLE");
    const event = lookup.event;
    const reason = titleReviewBlockReason(context, event);
    const reviewToken = await digest({ version: 1, actorId, context, event });
    if (body.action === "accept_title") {
      if (body.reviewToken !== reviewToken)
        throw new ReviewError("CALENDAR_REVIEW_STALE");
      if (reason) throw new ReviewError("CALENDAR_REVIEW_UNSAFE");
      // Recheck active administrator immediately before the only mutation.
      const authorization = await (dependencies.authorize ?? authorizeUser)(
        request,
        client,
      );
      if (
        authorization.profile.role !== "ADMIN" ||
        authorization.user.id !== actorId
      )
        throw new ReviewError("ADMIN_REQUIRED", 403);
      const { error: acceptedError } = await client.rpc(
        "accept_google_calendar_imported_title_review",
        {
          p_conflict_id: context.conflict.id,
          p_actor_id: actorId,
          p_expected_generation: context.connection.connection_generation,
          p_expected_automation_epoch: context.connection.automation_epoch,
          p_expected_conflict_updated_at: context.conflict.updated_at,
          p_expected_appointment_updated_at: context.appointment.updated_at,
          p_expected_contact_updated_at: context.contact.updated_at,
          p_expected_summary: context.source.summary,
          p_expected_google_etag: context.source.google_etag,
          p_reviewed_summary: event.summary!.trim(),
          p_reviewed_google_etag: event.etag!,
          p_reviewed_google_updated_at: instant(event.updated),
          p_reviewed_starts_at: instant(event.start?.dateTime),
          p_reviewed_ends_at: instant(event.end?.dateTime),
        },
      );
      if (acceptedError)
        throw new ReviewError(
          acceptedError.message.includes("BUSY")
            ? "CALENDAR_REVIEW_BUSY"
            : "CALENDAR_REVIEW_STALE",
        );
      return jsonResponse(request, { resolved: true });
    }
    return jsonResponse(request, {
      conflictId: context.conflict.id,
      imported: true,
      patientName: context.contact.name,
      local: {
        title: context.source.summary ?? "",
        startsAt: instant(context.appointment.starts_at),
        endsAt: instant(context.appointment.ends_at),
      },
      remote: {
        title:
          typeof event.summary === "string" ? event.summary.slice(0, 1024) : "",
        startsAt: instant(event.start?.dateTime),
        endsAt: instant(event.end?.dateTime),
        updatedAt: instant(event.updated),
      },
      // A diagnostic token cannot be replayed as a user's decision.
      reviewToken: service ? "" : reviewToken,
      canAcceptTitle: reason === null && !service,
      reason,
    });
  } catch (error) {
    const failure =
      error instanceof ReviewError
        ? error
        : error instanceof Error && error.message === "UNAUTHORIZED"
          ? new ReviewError("UNAUTHORIZED", 401)
          : new ReviewError("CALENDAR_REVIEW_UNAVAILABLE", 503);
    const message =
      failure.code === "CALENDAR_REVIEW_STALE"
        ? "El evento o el turno cambió mientras lo revisabas. Volvé a revisar antes de decidir."
        : failure.code === "CALENDAR_REVIEW_BUSY"
          ? "La sincronización está trabajando. Esperá unos segundos y volvé a revisar."
          : "No pudimos completar la revisión. No cambiamos el turno ni el evento de Google.";
    return jsonResponse(
      request,
      {
        error: failure.code,
        message,
        // Only locally-defined integration codes, never Google's response body,
        // event details, tokens or exception messages.
        ...(error instanceof GoogleIntegrationError
          ? { cause: error.code }
          : {}),
      },
      failure.status,
    );
  }
}

if (import.meta.main)
  Deno.serve((request) => handleGoogleCalendarConflictReviewRequest(request));
