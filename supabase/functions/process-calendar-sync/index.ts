import {
  type CalendarSyncAppointment,
  type ClassifiedExternalGoogleEvent,
  type ClassifiedGoogleEvent,
  classifyGoogleCalendarEvent,
  classifyGoogleCalendarEventAsExternal,
  deleteManagedGoogleCalendarEvent,
  deterministicGoogleEventId,
  getGoogleCalendarEvent,
  GoogleIntegrationError,
  googleOAuthConfiguration,
  listGoogleCalendarEvents,
  managedGoogleCalendarEventFingerprintIsValid,
  refreshGoogleAccessToken,
  safeGoogleErrorCode,
  upsertGoogleCalendarEvent,
} from "../_shared/google-calendar.ts";
import { assertGoogleCalendarSlotAvailable } from "../_shared/google-calendar-slot.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { secretMatches } from "../_shared/recovery-auth.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import { calendarJobFailureDecision } from "./sync-policy.ts";
import {
  emptyPatientImportSummary,
  importCalendarPatientAppointments,
} from "./patient-import.ts";
import {
  applyExternalEventOutcome,
  applyManagedEventOutcome,
  type CalendarSyncMode,
  calendarSyncOutcome,
  countClassifiedEvent,
  emptyInboundPreviewCounts,
  emptyInboundSyncSummary,
  GOOGLE_CALENDAR_SYNC_CONTRACT_VERSION,
  googleCalendarCoverageWindow,
  inboundChangeCount,
  type InboundSyncSummary,
  parseCalendarSyncMode,
  parseExternalEventRpcOutcome,
  parseManagedEventRpcOutcome,
  shouldImportExternalBlock,
} from "./inbound-policy.ts";

interface CalendarConnectionSecret {
  status?: string;
  google_calendar_id?: string;
  google_calendar_timezone?: string;
  refresh_token?: string;
  connection_generation?: number | string;
}

interface CalendarSyncJob extends Omit<
  CalendarSyncAppointment,
  "patient_phone" | "is_existing_patient" | "coverage"
> {
  job_id: string;
  operation: "upsert" | "delete";
  desired_version: number | string;
  attempts: number | string;
  connection_generation: number | string;
  google_event_id: string;
  automation_epoch: string;
  projection_stage: "pre_reservation" | "confirmed" | "absent";
  projected_stage?: "pre_reservation" | "confirmed" | "absent" | null;
  authorized_google_calendar_id: string;
  google_etag?: string | null;
}

interface ReconcileResult {
  queued?: number | string;
  already_queued?: number | string;
}

interface CalendarAutomationGate {
  automation_enabled?: boolean;
  automation_epoch?: string;
  google_calendar_id?: string;
  connection_generation?: number | string;
}

interface AuthorizedCalendarSyncJob {
  authorized?: boolean;
  google_calendar_id?: string;
  google_event_id?: string;
  operation?: string;
  projection_stage?: string;
  connection_generation?: number | string;
}

interface InboundLease {
  lease_token?: string;
  sync_token?: string | null;
  sync_state?: string;
  first_import_approved?: boolean;
  google_calendar_id?: string;
  google_calendar_timezone?: string;
}

interface FullResyncManagedCandidate {
  appointment_id?: unknown;
  google_event_id?: unknown;
  remote_known?: unknown;
}

export interface CalendarSyncDependencies {
  createClient?: () => SupabaseClient;
  authorize?: typeof authorizeUser;
  environment?: (name: string) => string | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
}

const MAX_INBOUND_PAGES = 12;
const PREVIEW_APPOINTMENT_BATCH_SIZE = 100;
const FULL_RESYNC_MANAGED_PAGE_SIZE = 100;
const MAX_FULL_RESYNC_MANAGED_PAGES = 100;
const GOOGLE_CALENDAR_PROJECTION_CONTRACT_VERSION = 2;
const APPOINTMENT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GOOGLE_CALENDAR_CRON_HEADER = "x-google-calendar-cron-secret";

function recurringOccurrenceKey(
  event: Parameters<typeof classifyGoogleCalendarEvent>[0],
): string | null {
  const recurringEventId =
    typeof event.recurringEventId === "string"
      ? event.recurringEventId.trim()
      : "";
  if (!recurringEventId) return null;
  const original = event.originalStartTime;
  const originalValue = original?.dateTime?.trim() || original?.date?.trim();
  return originalValue ? `${recurringEventId}\u0000${originalValue}` : null;
}

function assertUniqueEventObservation(
  eventIds: Map<string, string>,
  occurrenceIds: Map<string, string>,
  event: Parameters<typeof classifyGoogleCalendarEvent>[0],
  classified: ClassifiedGoogleEvent,
): boolean {
  if (classified.kind === "ignored" || !classified.eventId) return true;
  const fingerprint = JSON.stringify(classified);
  const previous = eventIds.get(classified.eventId);
  if (previous !== undefined) {
    if (previous !== fingerprint) {
      throw calendarWorkerFailure("CALENDAR_INBOUND_DUPLICATE_EVENT_MISMATCH");
    }
    return false;
  }
  eventIds.set(classified.eventId, fingerprint);

  const occurrenceKey = recurringOccurrenceKey(event);
  if (occurrenceKey) {
    const previousEventId = occurrenceIds.get(occurrenceKey);
    if (previousEventId && previousEventId !== classified.eventId) {
      throw calendarWorkerFailure(
        "CALENDAR_INBOUND_OCCURRENCE_IDENTITY_MISMATCH",
      );
    }
    occurrenceIds.set(occurrenceKey, classified.eventId);
  }
  return true;
}

function firstRow<T>(data: unknown): T | null {
  return (Array.isArray(data) ? data[0] : data) as T | null;
}

function validAutomaticGate(
  gate: CalendarAutomationGate | null,
): gate is CalendarAutomationGate & {
  automation_enabled: true;
  automation_epoch: string;
  google_calendar_id: string;
  connection_generation: number | string;
} {
  return Boolean(
    gate?.automation_enabled === true &&
    typeof gate.automation_epoch === "string" &&
    APPOINTMENT_UUID_PATTERN.test(gate.automation_epoch) &&
    typeof gate.google_calendar_id === "string" &&
    gate.google_calendar_id.trim() &&
    Number.isSafeInteger(Number(gate.connection_generation)),
  );
}

function assertClaimedJobAssociation(
  job: CalendarSyncJob,
  calendarId: string,
  generation: number,
  automaticEpoch: string | null,
): void {
  const upsertStage =
    job.projection_stage === "pre_reservation" ||
    job.projection_stage === "confirmed";
  if (
    !APPOINTMENT_UUID_PATTERN.test(job.job_id) ||
    !APPOINTMENT_UUID_PATTERN.test(job.appointment_id) ||
    !APPOINTMENT_UUID_PATTERN.test(job.automation_epoch) ||
    typeof job.google_event_id !== "string" ||
    !job.google_event_id.trim() ||
    job.google_event_id !== job.google_event_id.trim() ||
    job.google_event_id.length > 1024 ||
    job.authorized_google_calendar_id !== calendarId ||
    Number(job.connection_generation) !== generation ||
    !Number.isSafeInteger(Number(job.desired_version)) ||
    Number(job.desired_version) <= 0 ||
    (job.operation === "upsert" && !upsertStage) ||
    (job.operation === "delete" && job.projection_stage !== "absent") ||
    (job.projected_stage === "confirmed" &&
      job.projection_stage === "pre_reservation") ||
    (job.projected_stage !== undefined &&
      job.projected_stage !== null &&
      job.projected_stage !== "pre_reservation" &&
      job.projected_stage !== "confirmed" &&
      job.projected_stage !== "absent") ||
    (job.operation !== "upsert" && job.operation !== "delete") ||
    (automaticEpoch !== null && job.automation_epoch !== automaticEpoch)
  ) {
    throw calendarWorkerFailure("CALENDAR_JOB_ASSOCIATION_INVALID");
  }
}

async function assertCalendarJobStillAuthorized(input: {
  client: SupabaseClient;
  job: CalendarSyncJob;
  calendarId: string;
  generation: number;
}): Promise<void> {
  const { data, error } = await input.client.rpc(
    "authorize_google_calendar_sync_job",
    {
      p_job_id: input.job.job_id,
      p_claimed_version: input.job.desired_version,
      p_automation_epoch: input.job.automation_epoch,
      p_expected_stage: input.job.projection_stage,
    },
  );
  const authorization = firstRow<AuthorizedCalendarSyncJob>(data);
  if (
    error ||
    authorization?.authorized !== true ||
    authorization.google_calendar_id !== input.calendarId ||
    authorization.google_calendar_id !==
      input.job.authorized_google_calendar_id ||
    authorization.google_event_id !== input.job.google_event_id ||
    authorization.operation !== input.job.operation ||
    authorization.projection_stage !== input.job.projection_stage ||
    Number(authorization.connection_generation) !== input.generation
  ) {
    throw calendarWorkerFailure("CALENDAR_JOB_REAUTHORIZATION_FAILED");
  }
}

function inboundFailureRequiresReconnect(
  error: unknown,
  errorCode: string,
): boolean {
  if (
    errorCode === "GOOGLE_RECONNECT_REQUIRED" ||
    errorCode === "GOOGLE_CALENDAR_RECONNECT_REQUIRED" ||
    errorCode === "GOOGLE_SYNC_TOKEN_EXPIRED"
  ) {
    return true;
  }

  // Un 403 transitorio de cuota conserva `retryable=true`. Un 403 permanente
  // después de seleccionar un calendario owner indica que el grant perdió (o
  // nunca recibió) el permiso de eventos y necesita consentimiento nuevo.
  return (
    error instanceof GoogleIntegrationError &&
    error.status === 403 &&
    !error.retryable
  );
}

function calendarWorkerFailure(code: string): GoogleIntegrationError {
  return new GoogleIntegrationError(code, { status: 503, retryable: true });
}

async function calendarAppointmentWithPatientDetails(
  client: SupabaseClient,
  job: CalendarSyncJob,
): Promise<CalendarSyncAppointment> {
  // La cobertura corresponde al turno; nombre, ficha y celular al contacto.
  // Leer sólo estos campos evita exportar notas o información clínica.
  const { data, error } = await client
    .from("appointments")
    .select(
      "coverage,contact:contacts!appointments_contact_id_fkey(name,phone_e164,alternate_phone_e164,is_existing_patient)",
    )
    .eq("id", job.appointment_id)
    .maybeSingle<{
      coverage: CalendarSyncAppointment["coverage"];
      contact: {
        name: string;
        phone_e164: string | null;
        alternate_phone_e164: string | null;
        is_existing_patient: boolean | null;
      } | null;
    }>();
  if (error || !data?.contact || typeof data.contact.name !== "string") {
    throw calendarWorkerFailure("CALENDAR_PATIENT_DETAILS_UNAVAILABLE");
  }
  return {
    ...job,
    patient_name: data.contact.name,
    patient_phone: data.contact.phone_e164 ?? data.contact.alternate_phone_e164,
    is_existing_patient: data.contact.is_existing_patient,
    coverage: data.coverage,
  };
}

async function existingPreviewAppointmentIds(
  client: SupabaseClient,
  appointmentIds: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (
    let offset = 0;
    offset < appointmentIds.length;
    offset += PREVIEW_APPOINTMENT_BATCH_SIZE
  ) {
    const batch = appointmentIds.slice(
      offset,
      offset + PREVIEW_APPOINTMENT_BATCH_SIZE,
    );
    const requested = new Set(batch);
    const { data, error } = await client
      .from("appointments")
      .select("id")
      .in("id", batch);
    if (error || !Array.isArray(data)) {
      throw calendarWorkerFailure("CALENDAR_PREVIEW_APPOINTMENTS_FAILED");
    }
    for (const value of data) {
      const id =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as { id?: unknown }).id
          : null;
      const normalized = typeof id === "string" ? id.toLowerCase() : "";
      if (
        !APPOINTMENT_UUID_PATTERN.test(normalized) ||
        !requested.has(normalized)
      ) {
        throw calendarWorkerFailure("CALENDAR_PREVIEW_APPOINTMENTS_FAILED");
      }
      existing.add(normalized);
    }
  }
  return existing;
}

async function isAuthorizedInvocation(
  request: Request,
  client: SupabaseClient,
  dependencies: CalendarSyncDependencies,
): Promise<{ authorized: boolean; manual: boolean; userId: string | null }> {
  const environment =
    dependencies.environment ?? ((name: string) => Deno.env.get(name));
  if (request.headers.has(GOOGLE_CALENDAR_CRON_HEADER)) {
    const providedCronSecret =
      request.headers.get(GOOGLE_CALENDAR_CRON_HEADER) ?? "";
    const expectedCronSecret = environment("GOOGLE_CALENDAR_CRON_SECRET") ?? "";
    return {
      authorized: await secretMatches(providedCronSecret, expectedCronSecret),
      manual: false,
      userId: null,
    };
  }

  try {
    const { profile } = await (dependencies.authorize ?? authorizeUser)(
      request,
      client,
    );
    return {
      authorized: profile.role === "ADMIN",
      manual: true,
      userId: profile.id,
    };
  } catch {
    return { authorized: false, manual: true, userId: null };
  }
}

export async function handleCalendarSyncRequest(
  request: Request,
  dependencies: CalendarSyncDependencies = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const environment =
    dependencies.environment ?? ((name: string) => Deno.env.get(name));
  const fetcher = dependencies.fetcher ?? fetch;
  const client = (dependencies.createClient ?? createServiceClient)();
  const invocation = await isAuthorizedInvocation(
    request,
    client,
    dependencies,
  );
  if (!invocation.authorized) {
    return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
  }

  let mode: CalendarSyncMode = "manual";
  if (invocation.manual) {
    try {
      const input = (await request.json()) as { mode?: unknown };
      const parsed = parseCalendarSyncMode(input.mode);
      if (!parsed) {
        return jsonResponse(request, { error: "INVALID_REQUEST" }, 400);
      }
      mode = parsed;
    } catch {
      return jsonResponse(request, { error: "INVALID_REQUEST" }, 400);
    }
  }
  const automatic = !invocation.manual;

  try {
    const now = new Date((dependencies.now ?? Date.now)());
    let expiredHolds = 0;
    // Queda visible en la respuesta: el vencimiento no se pudo aplicar en esta
    // corrida y lo cubre el job de Postgres, no un reintento de Google.
    let holdExpirationDeferred = false;
    // El scheduler y el trigger inmediato comparten este gate SQL. Se consulta
    // antes de purgar candidatos, reconciliar cola, refrescar OAuth o tocar
    // Google; desplegar la infraestructura nunca activa la automatización.
    let automaticGate:
      | (CalendarAutomationGate & {
          automation_enabled: true;
          automation_epoch: string;
          google_calendar_id: string;
          connection_generation: number | string;
        })
      | null = null;
    if (automatic) {
      const { data: gateData, error: gateError } = await client.rpc(
        "get_google_calendar_automation_gate",
        {},
      );
      if (gateError) {
        throw calendarWorkerFailure("CALENDAR_AUTOMATION_GATE_FAILED");
      }
      const gate = firstRow<CalendarAutomationGate>(gateData);
      if (gate?.automation_enabled !== true) {
        return jsonResponse(request, {
          processed: false,
          ignored: true,
          outcome: "skipped",
          mode: "automatic",
          reason: "AUTOMATION_DISABLED",
        });
      }
      if (!validAutomaticGate(gate)) {
        throw calendarWorkerFailure("CALENDAR_AUTOMATION_GATE_INVALID");
      }
      automaticGate = gate;

      // El vencimiento es una transición interna existente y no depende de la
      // disponibilidad de Google. No reclama avisos ni ejecuta WhatsApp; el
      // delete que pueda encolar seguirá bloqueado hasta un pull inbound seguro.
      //
      // Su guard SQL exige una observación inbound sana, así que una corrida
      // fallida lo vuelve imposible. Abortar acá impedía el propio pull que
      // habría limpiado ese error: la automatización quedaba trabada hasta que
      // una persona sincronizara a mano. Se tolera y se sigue. No se pierde el
      // vencimiento: el job `booking-hold-expiration` lo ejecuta dentro de
      // Postgres cada minuto, sin depender de Google ni de esta función.
      const { data: expiredRows, error: expirationError } = await client.rpc(
        "expire_google_calendar_automation_booking_holds",
        {
          p_automation_epoch: automaticGate.automation_epoch,
          p_expected_generation: Number(automaticGate.connection_generation),
          p_expected_google_calendar_id: automaticGate.google_calendar_id,
          p_now: now.toISOString(),
        },
      );
      if (expirationError || !Array.isArray(expiredRows)) {
        holdExpirationDeferred = true;
      } else {
        expiredHolds = expiredRows.length;
      }
    }

    // El candidato OAuth vive en Vault y no debe depender de que alguien vuelva
    // a abrir Configuración para expirar. Cada invocación autenticada mantiene
    // ese TTL, y una respuesta inesperada nunca se interpreta como éxito.
    if (mode !== "preview") {
      const { data: purgedCandidates, error: purgeError } = await client.rpc(
        "purge_expired_google_calendar_connection_candidate",
        {},
      );
      if (
        purgeError ||
        typeof purgedCandidates !== "number" ||
        !Number.isSafeInteger(purgedCandidates) ||
        purgedCandidates < 0
      ) {
        throw calendarWorkerFailure("CALENDAR_CANDIDATE_PURGE_FAILED");
      }
    }

    const config = googleOAuthConfiguration(environment);

    if (mode === "approve_first_import") {
      if (!invocation.userId) {
        return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
      }
      const { data, error } = await client.rpc(
        "approve_google_calendar_first_import",
        { p_user_id: invocation.userId },
      );
      if (error) throw new Error("CALENDAR_FIRST_IMPORT_APPROVAL_FAILED");
      return jsonResponse(request, { approved: data === true });
    }

    const preview = mode === "preview";
    const inboundOnly = mode === "initial_import";

    // El preview no toca estado de sincronización: ni credenciales, ni cola
    // saliente, ni lease, ni bitácora. La reconciliación normal se difiere hasta
    // completar y revalidar el pull inbound exclusivo.
    let reconciliation: ReconcileResult | null = null;

    const { data: connectionData, error: connectionError } = await client.rpc(
      "get_google_calendar_windowed_connection_secret",
      {},
    );
    if (connectionError) throw new Error("CALENDAR_CONNECTION_UNAVAILABLE");
    const connection = firstRow<CalendarConnectionSecret>(connectionData);
    if (
      !connection ||
      connection.status !== "connected" ||
      !connection.google_calendar_id ||
      !connection.google_calendar_timezone ||
      !connection.refresh_token ||
      !Number.isSafeInteger(Number(connection.connection_generation))
    ) {
      return jsonResponse(request, {
        processed: false,
        ignored: true,
        outcome: "skipped",
        reason:
          connection?.status === "reconnect_required"
            ? "RECONNECT_REQUIRED"
            : "NOT_CONNECTED",
      });
    }
    const generation = Number(connection.connection_generation);
    const calendarId = connection.google_calendar_id;
    const calendarTimeZone = connection.google_calendar_timezone.trim();
    if (
      automaticGate &&
      (automaticGate.google_calendar_id !== calendarId ||
        Number(automaticGate.connection_generation) !== generation)
    ) {
      return jsonResponse(request, {
        processed: false,
        ignored: true,
        outcome: "skipped",
        mode: "automatic",
        reason: "AUTOMATION_SCOPE_CHANGED",
      });
    }
    let currentAutomationEpoch = automaticGate?.automation_epoch ?? null;
    if (!automatic && !preview) {
      const { data: gateData, error: gateError } = await client.rpc(
        "get_google_calendar_automation_gate",
        {},
      );
      if (gateError) {
        throw calendarWorkerFailure("CALENDAR_AUTOMATION_GATE_FAILED");
      }
      const gate = firstRow<CalendarAutomationGate>(gateData);
      if (gate?.automation_enabled === true) {
        if (
          !validAutomaticGate(gate) ||
          gate.google_calendar_id !== calendarId ||
          Number(gate.connection_generation) !== generation
        ) {
          throw calendarWorkerFailure("CALENDAR_AUTOMATION_GATE_INVALID");
        }
        currentAutomationEpoch = gate.automation_epoch;
      }
    }
    const coverage = googleCalendarCoverageWindow(now, calendarTimeZone);
    if (!coverage) {
      throw calendarWorkerFailure("CALENDAR_COVERAGE_WINDOW_INVALID");
    }

    let accessToken: string;
    try {
      const token = await refreshGoogleAccessToken({
        refreshToken: connection.refresh_token,
        config,
        fetcher,
      });
      accessToken = token.access_token;
    } catch (error) {
      const code = safeGoogleErrorCode(error);
      if (code === "GOOGLE_RECONNECT_REQUIRED") {
        await client.rpc("mark_google_calendar_reconnect_required", {
          p_error_code: code,
          p_expected_generation: generation,
        });
        return jsonResponse(request, {
          processed: false,
          outcome: "error",
          reconnectRequired: true,
        });
      }
      throw error;
    }

    // -----------------------------------------------------------------------
    // Preview: sólo cuenta. Cero escrituras en Google o en la base.
    // -----------------------------------------------------------------------
    if (preview) {
      let counts = emptyInboundPreviewCounts();
      let legacyManagedEvents = 0;
      let externalEvents = 0;
      let recurringOccurrences = 0;
      let cancelledRecurringOccurrences = 0;
      let allDayEvents = 0;
      let freeEventsIgnored = 0;
      const recurringSeriesIds = new Set<string>();
      const previewEventIds = new Map<string, string>();
      const previewOccurrenceIds = new Map<string, string>();
      const knownAppointments = new Map<string, boolean>();
      const currentManagedAssociations = new Map<string, boolean>();
      let pageToken: string | null = null;
      let pages = 0;

      const countExternalShape = (
        item: Parameters<typeof classifyGoogleCalendarEvent>[0],
        classified: ClassifiedExternalGoogleEvent,
      ) => {
        if (classified.kind === "ignored") return;
        const recurringEventId =
          typeof item.recurringEventId === "string"
            ? item.recurringEventId.trim()
            : "";
        const recurringMaster =
          Array.isArray(item.recurrence) && item.recurrence.length > 0;
        if (recurringEventId) recurringSeriesIds.add(recurringEventId);
        else if (recurringMaster) recurringSeriesIds.add(classified.eventId);

        const cancelled =
          classified.kind === "external_removed" &&
          classified.removalReason === "cancelled";
        if (cancelled) {
          if (recurringEventId) cancelledRecurringOccurrences += 1;
          return;
        }

        externalEvents += 1;
        if (recurringEventId) recurringOccurrences += 1;
        if (item.start?.date && item.end?.date) allDayEvents += 1;
        if (
          classified.kind === "external_removed" &&
          classified.removalReason === "transparent"
        ) {
          freeEventsIgnored += 1;
        }
      };

      do {
        const page = await listGoogleCalendarEvents({
          accessToken,
          calendarId,
          timeMin: coverage.startsAt,
          timeMax: coverage.endsAt,
          calendarTimeZone: coverage.timeZone,
          pageToken,
          maxResults: 2500,
          fetcher,
        });
        pages += 1;
        const classifiedItems: {
          item: (typeof page.items)[number];
          classified: ClassifiedGoogleEvent;
        }[] = [];
        for (const item of page.items) {
          const classified = classifyGoogleCalendarEvent(
            item,
            calendarTimeZone,
          );
          if (
            assertUniqueEventObservation(
              previewEventIds,
              previewOccurrenceIds,
              item,
              classified,
            )
          ) {
            classifiedItems.push({ item, classified });
          }
        }
        if (
          classifiedItems.some(
            ({ classified }) => classified.kind === "managed_mismatch",
          )
        ) {
          throw calendarWorkerFailure(
            "CALENDAR_INBOUND_MANAGED_EVENT_MISMATCH",
          );
        }
        const uncheckedAppointments = [
          ...new Set(
            classifiedItems.flatMap(({ classified }) => {
              if (classified.kind !== "managed") return [];
              const appointmentId = classified.appointmentId.toLowerCase();
              return knownAppointments.has(appointmentId)
                ? []
                : [appointmentId];
            }),
          ),
        ];
        const existingAppointments = await existingPreviewAppointmentIds(
          client,
          uncheckedAppointments,
        );
        for (const appointmentId of uncheckedAppointments) {
          knownAppointments.set(
            appointmentId,
            existingAppointments.has(appointmentId),
          );
        }
        for (const { classified } of classifiedItems) {
          if (classified.kind !== "managed") continue;
          const { data: associationCurrent, error: associationError } =
            await client.rpc("google_calendar_managed_event_is_current", {
              p_google_event_id: classified.eventId,
              p_appointment_id: classified.appointmentId,
              p_automation_epoch: classified.automationEpoch,
            });
          if (associationError || typeof associationCurrent !== "boolean") {
            throw calendarWorkerFailure(
              "CALENDAR_PREVIEW_MANAGED_ASSOCIATION_FAILED",
            );
          }
          currentManagedAssociations.set(
            classified.eventId,
            associationCurrent,
          );
        }

        for (const { item, classified } of classifiedItems) {
          if (
            classified.kind === "managed" &&
            (knownAppointments.get(classified.appointmentId.toLowerCase()) ===
              false ||
              currentManagedAssociations.get(classified.eventId) !== true)
          ) {
            legacyManagedEvents += 1;
            const external = classifyGoogleCalendarEventAsExternal(
              item,
              calendarTimeZone,
            );
            countExternalShape(item, external);
            counts = countClassifiedEvent(counts, external, now);
            continue;
          }
          if (classified.kind === "managed_legacy") {
            legacyManagedEvents += 1;
            const external = classifyGoogleCalendarEventAsExternal(
              item,
              calendarTimeZone,
            );
            countExternalShape(item, external);
            counts = countClassifiedEvent(counts, external, now);
            continue;
          }
          if (
            classified.kind !== "managed" &&
            classified.kind !== "managed_mismatch"
          ) {
            countExternalShape(item, classified);
          }
          counts = countClassifiedEvent(counts, classified, now);
        }
        pageToken = page.nextPageToken;
      } while (pageToken && pages < MAX_INBOUND_PAGES);

      const truncated = Boolean(pageToken);
      return jsonResponse(
        request,
        {
          processed: true,
          mode: "preview",
          outcome: truncated ? "partial" : "completed",
          mutated: false,
          pagesFetched: pages,
          truncated,
          coverage: {
            startDate: coverage.startDate,
            endDateExclusive: coverage.endDateExclusive,
            days: coverage.days,
            timeZone: coverage.timeZone,
          },
          preview: {
            managedEvents: counts.managed,
            legacyManagedEvents,
            externalEvents,
            recurringSeries: recurringSeriesIds.size,
            recurringOccurrences,
            cancelledRecurringOccurrences,
            allDayEvents,
            freeEventsIgnored,
            wouldBecomeBlocks: counts.externalBlocks,
            pastEventsIgnored: counts.pastBlocks,
            unsupportedEvents: counts.externalUnsupported,
            cancelledEvents: counts.externalRemoved,
            ignoredEvents: counts.ignored,
          },
        },
        truncated ? 503 : 200,
      );
    }

    // -----------------------------------------------------------------------
    // El pull va PRIMERO. Empujar antes de leer permitía que una reproyección
    // pendiente pisara en Google un cambio externo antes de que nadie lo viera.
    // -----------------------------------------------------------------------
    let inbound: InboundRunResult = {
      ...emptyInboundSyncSummary(),
      nextSyncToken: null,
      truncated: false,
    };
    let inboundSkippedReason: string | null = null;
    let inboundError: string | null = null;
    let inboundFailure: unknown = null;
    let leaseToken: string | null = null;

    const { data: leaseData, error: leaseError } = await client.rpc(
      "begin_google_calendar_inbound_sync",
      {
        p_expected_generation: generation,
        p_lease_seconds: 240,
        p_sync_contract_version: GOOGLE_CALENDAR_SYNC_CONTRACT_VERSION,
        p_coverage_starts_at: coverage.startsAt,
        p_coverage_ends_at: coverage.endsAt,
      },
    );
    if (leaseError) throw new Error("CALENDAR_INBOUND_LEASE_FAILED");
    const lease = firstRow<InboundLease>(leaseData);

    if (!lease?.lease_token) {
      inboundSkippedReason = "INBOUND_SYNC_IN_PROGRESS";
    } else if (lease.google_calendar_id !== calendarId) {
      leaseToken = lease.lease_token;
      inboundFailure = calendarWorkerFailure("CALENDAR_INBOUND_SCOPE_MISMATCH");
      inboundError = "CALENDAR_INBOUND_SCOPE_MISMATCH";
    } else if (lease.google_calendar_timezone !== calendarTimeZone) {
      leaseToken = lease.lease_token;
      inboundFailure = calendarWorkerFailure("CALENDAR_INBOUND_SCOPE_MISMATCH");
      inboundError = "CALENDAR_INBOUND_SCOPE_MISMATCH";
    } else if (!lease.sync_token && lease.first_import_approved !== true) {
      inboundSkippedReason = "FIRST_IMPORT_APPROVAL_REQUIRED";
      const { data: released, error: releaseError } = await client.rpc(
        "release_google_calendar_inbound_lease",
        {
          p_expected_generation: generation,
          p_lease_token: lease.lease_token,
        },
      );
      if (releaseError || released !== true) {
        throw calendarWorkerFailure("CALENDAR_INBOUND_LEASE_RELEASE_FAILED");
      }
    } else {
      leaseToken = lease.lease_token;
      try {
        inbound = await runInboundSync({
          client,
          accessToken,
          calendarId,
          generation,
          leaseToken,
          syncToken: lease.sync_token ?? null,
          calendarTimeZone,
          coverageStartsAt: coverage.startsAt,
          coverageEndsAt: coverage.endsAt,
          automationEpoch: currentAutomationEpoch,
          now,
          fetcher,
        });
      } catch (error) {
        inboundFailure = error;
        inboundError = safeGoogleErrorCode(error);
      }
    }

    // Criterio para permitir App -> Google: hubo lease exclusivo, la primera
    // importación estaba aprobada, el pull terminó sin errores ni truncamiento y
    // Google entregó el nextSyncToken de la última página. Preview retorna antes
    // de este bloque y nunca reclama la cola.
    if (
      leaseToken &&
      !inboundError &&
      !inbound.truncated &&
      !inbound.nextSyncToken
    ) {
      inboundFailure = calendarWorkerFailure("GOOGLE_SYNC_TOKEN_MISSING");
      inboundError = "GOOGLE_SYNC_TOKEN_MISSING";
    }
    let inboundObservationSafe = Boolean(
      leaseToken &&
      !inboundSkippedReason &&
      !inboundError &&
      !inbound.truncated &&
      inbound.nextSyncToken,
    );
    if (inboundObservationSafe && leaseToken) {
      const { error: leaseAssertionError } = await client.rpc(
        "assert_google_calendar_inbound_lease",
        {
          p_expected_generation: generation,
          p_lease_token: leaseToken,
        },
      );
      if (leaseAssertionError) {
        inboundFailure = calendarWorkerFailure("CALENDAR_INBOUND_LEASE_LOST");
        inboundError = safeGoogleErrorCode(inboundFailure);
        inboundObservationSafe = false;
      }
    }

    // -----------------------------------------------------------------------
    // Salida: App -> Google. Los turnos con un conflicto pendiente quedan
    // retenidos por `claim_google_calendar_sync_jobs`, no se reproyectan.
    // La importación inicial explícita es inbound-only: primero preserva todo
    // lo que ya existe en Google y no procesa ninguna cola global.
    // -----------------------------------------------------------------------
    let jobs: CalendarSyncJob[] = [];
    if (inboundObservationSafe && !inboundOnly) {
      const { data: reconcileData, error: reconcileError } = await client.rpc(
        "reconcile_google_calendar_sync",
        {},
      );
      if (reconcileError) {
        throw calendarWorkerFailure("CALENDAR_RECONCILIATION_FAILED");
      }
      reconciliation = firstRow<ReconcileResult>(reconcileData);

      const { data: claimedData, error: claimError } = await client.rpc(
        "claim_google_calendar_sync_jobs",
        {
          p_limit: 3,
          p_expected_generation: generation,
          p_projection_contract_version:
            GOOGLE_CALENDAR_PROJECTION_CONTRACT_VERSION,
        },
      );
      if (claimError) throw calendarWorkerFailure("CALENDAR_CLAIM_FAILED");
      jobs = (claimedData ?? []) as CalendarSyncJob[];
    }

    let synced = 0;
    let inserted = 0;
    let patched = 0;
    let adopted = 0;
    let deleted = 0;
    let retried = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        assertClaimedJobAssociation(
          job,
          calendarId,
          generation,
          automaticGate?.automation_epoch ?? null,
        );
        const eventId = job.google_event_id;
        const beforeMutation = async () => {
          await assertCalendarJobStillAuthorized({
            client,
            job,
            calendarId,
            generation,
          });
          if (job.operation === "upsert") {
            const { data: settings, error: settingsError } = await client
              .from("app_settings")
              .select("appointment_buffer_minutes")
              .eq("id", true)
              .maybeSingle();
            if (settingsError || !settings) {
              throw calendarWorkerFailure("CALENDAR_SLOT_SETTINGS_UNAVAILABLE");
            }
            await assertGoogleCalendarSlotAvailable({
              accessToken,
              calendarId: job.authorized_google_calendar_id,
              calendarTimeZone,
              startsAt: job.starts_at,
              endsAt: job.ends_at,
              bufferMinutes: settings.appointment_buffer_minutes,
              ownEventId: eventId,
              appointmentId: job.appointment_id,
              automationEpoch: job.automation_epoch,
              fetcher,
            });
            // The extra network read must not outlive the job authorization.
            await assertCalendarJobStillAuthorized({
              client,
              job,
              calendarId,
              generation,
            });
          }
        };
        let externalUpsertOperation: "inserted" | "patched" | "adopted" | null =
          null;
        let projectedEtag: string | null = null;
        if (job.operation === "delete") {
          await deleteManagedGoogleCalendarEvent({
            accessToken,
            calendarId: job.authorized_google_calendar_id,
            eventId,
            appointmentId: job.appointment_id,
            automationEpoch: job.automation_epoch,
            beforeMutation,
            etag: job.google_etag ?? null,
            fetcher,
          });
        } else if (job.operation === "upsert") {
          if (job.projection_stage === "absent") {
            throw calendarWorkerFailure("CALENDAR_JOB_ASSOCIATION_INVALID");
          }
          const appointment = await calendarAppointmentWithPatientDetails(
            client,
            job,
          );
          const upsertResult = await upsertGoogleCalendarEvent({
            accessToken,
            calendarId: job.authorized_google_calendar_id,
            appointment,
            association: {
              eventId,
              automationEpoch: job.automation_epoch,
              projectionStage: job.projection_stage,
              projectedStage: job.projected_stage,
            },
            beforeMutation,
            etag: job.google_etag ?? null,
            fetcher,
          });
          externalUpsertOperation = upsertResult.operation;
          projectedEtag = upsertResult.etag;
        } else {
          throw new Error("CALENDAR_JOB_OPERATION_INVALID");
        }

        const { data: completed, error: completeError } = await client.rpc(
          "complete_google_calendar_sync_job",
          {
            p_job_id: job.job_id,
            p_claimed_version: job.desired_version,
            p_google_event_id: eventId,
            p_connection_generation: job.connection_generation,
            p_google_etag: projectedEtag,
            p_projected_starts_at: job.starts_at,
            p_projected_ends_at: job.ends_at,
            p_automation_epoch: job.automation_epoch,
            p_projection_stage: job.projection_stage,
          },
        );
        if (completeError) {
          throw new GoogleIntegrationError("CALENDAR_JOB_COMPLETE_FAILED", {
            status: 503,
            retryable: true,
          });
        }
        if (completed !== true) {
          // El turno, stage o epoch cambió mientras Google respondía. La
          // asociación persistida conserva el evento para la nueva versión;
          // nunca se intenta un borrado compensatorio sin reautorización.
          continue;
        }
        if (job.operation === "delete") deleted += 1;
        else {
          synced += 1;
          if (externalUpsertOperation === "inserted") inserted += 1;
          else if (externalUpsertOperation === "patched") patched += 1;
          else adopted += 1;
        }
      } catch (error) {
        const decision = calendarJobFailureDecision(error, job.attempts);

        if (decision.errorCode === "GOOGLE_CALENDAR_RECONNECT_REQUIRED") {
          await client.rpc("mark_google_calendar_reconnect_required", {
            p_error_code: decision.errorCode,
            p_expected_generation: job.connection_generation,
          });
        }

        const { error: failError } = await client.rpc(
          "fail_google_calendar_sync_job",
          {
            p_job_id: job.job_id,
            p_claimed_version: job.desired_version,
            p_connection_generation: job.connection_generation,
            p_error_code: decision.errorCode,
            p_retry_at: decision.retryAt,
            p_terminal: decision.terminal,
            p_automation_epoch: job.automation_epoch,
            p_projection_stage: job.projection_stage,
          },
        );
        if (failError) {
          console.error("process-calendar-sync", "CALENDAR_JOB_FAIL_FAILED");
        }
        if (!decision.terminal) retried += 1;
        else failed += 1;
      }
    }

    // Los eventos externos son sólo lectura en esta versión. Una conversión
    // conserva el bloqueo original y nunca dispara cleanup/delete en Google.
    const cleanupDone = 0;
    const cleanupFailed = 0;

    const summary = {
      ...emptyPatientImportSummary(),
      pushed: inserted,
      updatedInGoogle: patched,
      adoptedInGoogle: adopted,
      deletedInGoogle: deleted,
      retried,
      failed,
      blocksImported: inbound.blocksImported,
      blocksUpdated: inbound.blocksUpdated,
      blocksRemoved: inbound.blocksRemoved,
      blocksUnchanged: inbound.blocksUnchanged,
      conflictsOpened: inbound.conflictsOpened,
      managedInSync: inbound.managedInSync,
      skipped: inbound.skipped,
      pagesFetched: inbound.pagesFetched,
      fullResync: inbound.fullResync,
    };

    let outcome = calendarSyncOutcome({
      inboundError,
      inboundSkippedReason,
      truncated: inbound.truncated,
      retried,
      failed,
      cleanupFailed,
    });

    const changes = synced + deleted + inboundChangeCount(inbound);
    if (leaseToken && !inboundObservationSafe) {
      const failureCode =
        inboundError ??
        (inbound.truncated
          ? "GOOGLE_EVENTS_LIST_TRUNCATED"
          : "CALENDAR_INBOUND_OBSERVATION_INCOMPLETE");
      const { data: failureRecorded, error: failureRecordError } =
        await client.rpc("fail_google_calendar_inbound_sync", {
          p_expected_generation: generation,
          p_lease_token: leaseToken,
          p_error_code: failureCode,
          p_summary: summary,
        });

      let finalizationError =
        failureRecordError || failureRecorded !== true
          ? "CALENDAR_INBOUND_FAIL_RECORD_FAILED"
          : null;

      if (
        inboundFailureRequiresReconnect(
          inboundFailure,
          inboundError ?? failureCode,
        )
      ) {
        const { error: reconnectError } = await client.rpc(
          "mark_google_calendar_reconnect_required",
          {
            p_error_code: inboundError ?? failureCode,
            p_expected_generation: generation,
          },
        );
        if (reconnectError) {
          finalizationError = "CALENDAR_RECONNECT_MARK_FAILED";
        }
      }

      if (finalizationError) throw calendarWorkerFailure(finalizationError);
    } else if (leaseToken && inboundObservationSafe) {
      const { data: inboundCompleted, error: inboundCompleteError } =
        await client.rpc("complete_google_calendar_inbound_sync", {
          p_expected_generation: generation,
          p_lease_token: leaseToken,
          p_next_sync_token: inbound.nextSyncToken,
          p_summary: summary,
          p_changes: changes,
          p_sync_contract_version: GOOGLE_CALENDAR_SYNC_CONTRACT_VERSION,
          p_coverage_starts_at: coverage.startsAt,
          p_coverage_ends_at: coverage.endsAt,
        });
      if (inboundCompleteError || inboundCompleted !== true) {
        // Si la transacción de cierre no confirmó, el token incremental no se
        // considera avanzado. Se intenta liberar el lease conservando el error
        // original para que la próxima ejecución relea la misma ventana.
        await client.rpc("fail_google_calendar_inbound_sync", {
          p_expected_generation: generation,
          p_lease_token: leaseToken,
          p_error_code: "CALENDAR_INBOUND_COMPLETE_FAILED",
          p_summary: summary,
        });
        throw calendarWorkerFailure("CALENDAR_INBOUND_COMPLETE_FAILED");
      }
    } else {
      // Sin lease no hubo pull, pero la revisión existió igual.
      const { data: attemptRecorded, error: attemptRecordError } =
        await client.rpc("record_google_calendar_sync_attempt", {
          p_expected_generation: generation,
          p_summary: summary,
          p_changes: changes,
          p_note: null,
        });
      if (attemptRecordError || attemptRecorded !== true) {
        throw calendarWorkerFailure("CALENDAR_SYNC_ATTEMPT_RECORD_FAILED");
      }
    }

    // A prior complete pull is essential: never convert a patient event from
    // an incomplete page, an expired scope, or the preview/initial import.
    // Scan persisted active blocks as well as newly changed events so adding
    // a missing patient later can resolve a previously incomplete title.
    if (inboundObservationSafe && !inboundOnly && currentAutomationEpoch) {
      try {
        Object.assign(
          summary,
          await importCalendarPatientAppointments({
            client,
            calendarId,
            generation,
            automationEpoch: currentAutomationEpoch,
            coverageStartsAt: coverage.startsAt,
            coverageEndsAt: coverage.endsAt,
            now,
          }),
        );
      } catch {
        summary.patientImportsFailed += 1;
      }
      if (summary.patientImportsFailed > 0) outcome = "partial";
      if (
        summary.appointmentsImported ||
        summary.patientImportsNeedReview ||
        summary.patientImportsFailed
      ) {
        const { data: recorded, error: recordError } = await client.rpc(
          "record_google_calendar_sync_attempt",
          {
            p_expected_generation: generation,
            p_summary: summary,
            p_changes: changes + summary.appointmentsImported,
            p_note: summary.patientImportsFailed
              ? "CALENDAR_PATIENT_IMPORT_FAILED"
              : null,
          },
        );
        if (recordError || recorded !== true) {
          throw calendarWorkerFailure("CALENDAR_PATIENT_IMPORT_RECORD_FAILED");
        }
      }
    }

    return jsonResponse(
      request,
      {
        processed: true,
        outcome,
        mode: automatic ? "automatic" : mode,
        reconciliation: {
          queued: Number(reconciliation?.queued ?? 0),
          alreadyQueued: Number(reconciliation?.already_queued ?? 0),
        },
        claimed: jobs.length,
        synced,
        adopted,
        deleted,
        retried,
        failed,
        expiredHolds,
        holdExpirationDeferred,
        cleanup: { done: cleanupDone, failed: cleanupFailed },
        inbound: {
          ...summary,
          truncated: inbound.truncated,
          skippedReason: inboundSkippedReason,
          error: inboundError,
        },
        coverage: {
          startDate: coverage.startDate,
          endDateExclusive: coverage.endDateExclusive,
          days: coverage.days,
          timeZone: coverage.timeZone,
        },
        summary,
      },
      inboundError || inbound.truncated ? 503 : 200,
    );
  } catch (error) {
    const code = safeGoogleErrorCode(error);
    console.error("process-calendar-sync", code);
    return jsonResponse(
      request,
      {
        error: code,
        outcome: "error",
        message: "No pudimos completar la sincronización con Google Calendar.",
      },
      503,
    );
  }
}

interface InboundRunResult extends InboundSyncSummary {
  nextSyncToken: string | null;
  truncated: boolean;
}

async function runInboundSync(input: {
  client: SupabaseClient;
  accessToken: string;
  calendarId: string;
  generation: number;
  leaseToken: string;
  syncToken: string | null;
  calendarTimeZone: string;
  coverageStartsAt: string;
  coverageEndsAt: string;
  automationEpoch: string | null;
  now: Date;
  fetcher: typeof fetch;
}): Promise<InboundRunResult> {
  const { client, generation, leaseToken } = input;
  let syncToken = input.syncToken;
  let attemptedFullResync = syncToken === null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await pullGoogleCalendar({ ...input, syncToken });
    } catch (error) {
      const code = safeGoogleErrorCode(error);
      // HTTP 410: token caducado. Se descarta y se reintenta una única vez con
      // una corrida completa. Nunca se borran turnos ni pacientes: los mapeos
      // existentes se reconcilian por google_event_id.
      if (code !== "GOOGLE_SYNC_TOKEN_EXPIRED" || attemptedFullResync) {
        throw error;
      }
      const { data: invalidated, error: invalidationError } = await client.rpc(
        "invalidate_google_calendar_sync_token",
        {
          p_expected_generation: generation,
          p_lease_token: leaseToken,
        },
      );
      if (invalidationError !== null || invalidated !== true) {
        throw calendarWorkerFailure("CALENDAR_SYNC_TOKEN_INVALIDATION_FAILED");
      }
      syncToken = null;
      attemptedFullResync = true;
    }
  }
  throw new GoogleIntegrationError("GOOGLE_SYNC_TOKEN_EXPIRED", {
    status: 410,
  });
}

async function pullGoogleCalendar(input: {
  client: SupabaseClient;
  accessToken: string;
  calendarId: string;
  generation: number;
  leaseToken: string;
  syncToken: string | null;
  calendarTimeZone: string;
  coverageStartsAt: string;
  coverageEndsAt: string;
  automationEpoch: string | null;
  now: Date;
  fetcher: typeof fetch;
}): Promise<InboundRunResult> {
  const { client, generation, leaseToken } = input;
  const now = input.now;
  const fullResync = input.syncToken === null;
  const timeMin = fullResync ? input.coverageStartsAt : null;
  const timeMax = fullResync ? input.coverageEndsAt : null;
  let summary = emptyInboundSyncSummary();
  summary = { ...summary, fullResync };

  const seenEventIds = new Set<string>();
  const seenEventFingerprints = new Map<string, string>();
  const seenOccurrenceIds = new Map<string, string>();
  const observedManagedAppointments = new Map<string, string>();
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;
  let pages = 0;

  const observeManaged = async (managed: {
    eventId: string;
    appointmentId: string;
    automationEpoch: string;
    projectionStage: "pre_reservation" | "confirmed" | null;
    cancelled: boolean;
    startsAt: string | null;
    endsAt: string | null;
    updatedAt: string | null;
    etag: string | null;
    payloadFingerprintValid: boolean;
  }) => {
    const previouslyObservedAppointment = observedManagedAppointments.get(
      managed.eventId,
    );
    if (
      previouslyObservedAppointment &&
      previouslyObservedAppointment !== managed.appointmentId
    ) {
      throw calendarWorkerFailure("CALENDAR_INBOUND_MANAGED_EVENT_MISMATCH");
    }
    const { data, error } = await client.rpc(
      "observe_google_calendar_managed_event",
      {
        p_expected_generation: generation,
        p_lease_token: leaseToken,
        p_google_event_id: managed.eventId,
        p_appointment_id: managed.appointmentId,
        p_cancelled: managed.cancelled,
        p_starts_at: managed.startsAt,
        p_ends_at: managed.endsAt,
        p_google_updated_at: managed.updatedAt,
        p_google_etag: managed.etag,
        p_automation_epoch: managed.automationEpoch,
        p_remote_projection_stage: managed.projectionStage,
        p_payload_fingerprint_valid: managed.payloadFingerprintValid,
      },
    );
    if (error !== null) {
      throw calendarWorkerFailure("CALENDAR_INBOUND_OBSERVE_FAILED");
    }
    const outcome = parseManagedEventRpcOutcome(data);
    if (!outcome) {
      throw calendarWorkerFailure("CALENDAR_INBOUND_OBSERVE_INVALID_OUTCOME");
    }
    // Un marcador managed legado puede apuntar a un turno que no existe en
    // esta base. En ese único caso quien llama lo vuelve a clasificar por su
    // forma externa para no perder la ocupación remota.
    if (outcome !== "ignored_unknown_appointment") {
      summary = applyManagedEventOutcome(summary, outcome);
    }
    observedManagedAppointments.set(managed.eventId, managed.appointmentId);
    return outcome;
  };

  const applyExternal = async (
    classified: ClassifiedExternalGoogleEvent,
    options: { suppressRemovalNoop?: boolean } = {},
  ): Promise<void> => {
    if (classified.kind === "ignored") {
      summary = { ...summary, skipped: summary.skipped + 1 };
      return;
    }

    // Un bloqueo ya conocido puede moverse desde un horario futuro hacia el
    // pasado. Tratarlo sólo como "ignorado" dejaría activo en la base su rango
    // futuro anterior. `p_removed=true` retira el existente de forma
    // idempotente y no crea ninguna fila si nunca se había importado.
    const pastExternalBlock =
      classified.kind === "external_block" &&
      !shouldImportExternalBlock({ endsAt: classified.endsAt, now });
    const removed = classified.kind === "external_removed" || pastExternalBlock;
    const { data, error } = await client.rpc(
      "apply_google_calendar_external_event",
      {
        p_expected_generation: generation,
        p_lease_token: leaseToken,
        p_google_event_id: classified.eventId,
        p_kind: classified.kind === "external_block" ? "block" : "unsupported",
        p_removed: removed,
        // Keep the observation for an already-converted patient source. Past
        // and transparent events stop being blocks but are not tombstones.
        p_summary:
          classified.kind === "external_removed"
            ? null
            : (classified.summary ?? null),
        p_starts_at:
          classified.kind === "external_block" ? classified.startsAt : null,
        p_ends_at:
          classified.kind === "external_block" ? classified.endsAt : null,
        p_all_day:
          classified.kind === "external_block"
            ? classified.allDay
            : classified.kind === "external_unsupported" &&
              classified.reason === "ALL_DAY",
        p_recurring:
          classified.kind === "external_block"
            ? classified.recurring
            : classified.kind === "external_unsupported" &&
              classified.reason === "RECURRING",
        p_unsupported_reason: pastExternalBlock
          ? "PAST_EVENT"
          : classified.kind === "external_removed" &&
              classified.removalReason === "transparent"
            ? "TRANSPARENT_EVENT"
            : classified.kind === "external_unsupported"
              ? classified.reason
              : null,
        p_google_etag: classified.etag,
        p_google_updated_at: classified.updatedAt,
      },
    );
    if (error !== null) {
      // La clasificación ya aisló formatos no soportados. Un error del RPC
      // puede ser pérdida de lease o una falla transitoria de base: avanzar el
      // syncToken lo perdería de manera definitiva.
      throw calendarWorkerFailure("CALENDAR_INBOUND_APPLY_FAILED");
    }
    const outcome = parseExternalEventRpcOutcome(data);
    if (!outcome) {
      throw calendarWorkerFailure("CALENDAR_INBOUND_APPLY_INVALID_OUTCOME");
    }
    if (
      options.suppressRemovalNoop &&
      (outcome === "already_removed" || outcome === "skipped_converted")
    ) {
      return;
    }
    summary = applyExternalEventOutcome(summary, outcome);
  };

  const retireExternalFallback = async (managed: {
    eventId: string;
    updatedAt: string | null;
    etag: string | null;
  }): Promise<void> => {
    await applyExternal(
      {
        kind: "external_removed",
        eventId: managed.eventId,
        updatedAt: managed.updatedAt,
        etag: managed.etag,
        removalReason: "cancelled",
      },
      { suppressRemovalNoop: true },
    );
  };

  do {
    // Google pide repetir el mismo juego de parámetros en cada página, así que
    // el syncToken viaja también junto al pageToken.
    const page = await listGoogleCalendarEvents({
      accessToken: input.accessToken,
      calendarId: input.calendarId,
      syncToken: input.syncToken,
      timeMin,
      timeMax,
      calendarTimeZone: input.calendarTimeZone,
      pageToken,
      maxResults: 2500,
      fetcher: input.fetcher,
    });
    pages += 1;

    for (const item of page.items) {
      const classified = classifyGoogleCalendarEvent(
        item,
        input.calendarTimeZone,
      );
      if (
        !assertUniqueEventObservation(
          seenEventFingerprints,
          seenOccurrenceIds,
          item,
          classified,
        )
      ) {
        continue;
      }
      if (classified.kind === "managed_mismatch") {
        throw calendarWorkerFailure("CALENDAR_INBOUND_MANAGED_EVENT_MISMATCH");
      }
      if (classified.kind === "managed_legacy") {
        seenEventIds.add(classified.eventId);
        await applyExternal(
          classifyGoogleCalendarEventAsExternal(item, input.calendarTimeZone),
        );
        continue;
      }
      if (classified.kind === "ignored") {
        summary = { ...summary, skipped: summary.skipped + 1 };
        continue;
      }
      seenEventIds.add(classified.eventId);

      if (classified.kind === "managed") {
        const outcome = await observeManaged({
          ...classified,
          payloadFingerprintValid:
            await managedGoogleCalendarEventFingerprintIsValid(item),
        });
        if (outcome === "ignored_unknown_appointment") {
          await applyExternal(
            classifyGoogleCalendarEventAsExternal(item, input.calendarTimeZone),
          );
        } else {
          await retireExternalFallback(classified);
        }
        continue;
      }

      // Un evento borrado llega con `id` y `status` solamente, sin
      // extendedProperties: el mapeo guardado en la cola lo identifica.
      if (
        classified.kind === "external_removed" &&
        classified.removalReason === "cancelled"
      ) {
        const { data: mappedAppointment, error: mappingError } =
          await client.rpc("google_calendar_managed_appointment_for_event", {
            p_google_event_id: classified.eventId,
          });
        if (mappingError) throw new Error("CALENDAR_INBOUND_MAPPING_FAILED");
        if (typeof mappedAppointment === "string" && mappedAppointment) {
          if (!input.automationEpoch) {
            throw calendarWorkerFailure(
              "CALENDAR_INBOUND_MANAGED_ASSOCIATION_MISSING",
            );
          }
          const outcome = await observeManaged({
            eventId: classified.eventId,
            appointmentId: mappedAppointment,
            automationEpoch: input.automationEpoch,
            projectionStage: null,
            cancelled: true,
            startsAt: null,
            endsAt: null,
            updatedAt: classified.updatedAt,
            etag: classified.etag,
            payloadFingerprintValid: false,
          });
          if (outcome !== "ignored_unknown_appointment") {
            await retireExternalFallback(classified);
            continue;
          }
        }
      }
      await applyExternal(classified);
    }

    pageToken = page.nextPageToken;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken && pages < MAX_INBOUND_PAGES);

  // Sólo una corrida completa sabe qué eventos ya no existen. El token nuevo se
  // guarda únicamente cuando se recorrieron todas las páginas.
  if (fullResync && !pageToken) {
    const auditedAppointments = new Set<string>();
    const auditedEventIds = new Set<string>();
    let afterAppointmentId: string | null = null;
    let managedAuditFinished = false;

    for (
      let auditPage = 0;
      auditPage < MAX_FULL_RESYNC_MANAGED_PAGES;
      auditPage += 1
    ) {
      const candidateResult: { data: unknown; error: unknown } =
        await client.rpc(
          "list_google_calendar_full_resync_managed_candidates",
          {
            p_expected_generation: generation,
            p_lease_token: leaseToken,
            p_after_appointment_id: afterAppointmentId,
            p_limit: FULL_RESYNC_MANAGED_PAGE_SIZE,
          },
        );
      const candidateData: unknown = candidateResult.data;
      if (
        candidateResult.error !== null ||
        !Array.isArray(candidateData) ||
        candidateData.length > FULL_RESYNC_MANAGED_PAGE_SIZE
      ) {
        throw calendarWorkerFailure(
          "CALENDAR_FULL_RESYNC_MANAGED_CANDIDATES_FAILED",
        );
      }
      if (candidateData.length === 0) {
        managedAuditFinished = true;
        break;
      }

      const candidates = candidateData as FullResyncManagedCandidate[];
      let pageCursor: string | null = afterAppointmentId;
      for (const value of candidates) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw calendarWorkerFailure(
            "CALENDAR_FULL_RESYNC_MANAGED_CANDIDATES_INVALID",
          );
        }
        const rawAppointmentId: unknown = value.appointment_id;
        const appointmentId: string =
          typeof rawAppointmentId === "string"
            ? rawAppointmentId.trim().toLowerCase()
            : "";
        const rawEventId: unknown = value.google_event_id;
        const storedEventId: string | null =
          typeof rawEventId === "string" ? rawEventId.trim() : null;
        if (
          !APPOINTMENT_UUID_PATTERN.test(appointmentId) ||
          auditedAppointments.has(appointmentId) ||
          (pageCursor !== null && appointmentId <= pageCursor) ||
          (rawEventId !== null && typeof rawEventId !== "string") ||
          (storedEventId !== null &&
            (!storedEventId ||
              storedEventId.length > 1024 ||
              /[\r\n]/.test(storedEventId))) ||
          typeof value.remote_known !== "boolean" ||
          (value.remote_known && storedEventId === null)
        ) {
          throw calendarWorkerFailure(
            "CALENDAR_FULL_RESYNC_MANAGED_CANDIDATES_INVALID",
          );
        }

        const eventId =
          storedEventId ?? deterministicGoogleEventId(appointmentId);
        if (auditedEventIds.has(eventId)) {
          throw calendarWorkerFailure(
            "CALENDAR_FULL_RESYNC_MANAGED_CANDIDATES_INVALID",
          );
        }
        auditedAppointments.add(appointmentId);
        auditedEventIds.add(eventId);
        pageCursor = appointmentId;

        if (seenEventIds.has(eventId)) {
          const observedAppointment = observedManagedAppointments.get(eventId);
          if (
            observedAppointment !== undefined &&
            observedAppointment !== appointmentId
          ) {
            throw calendarWorkerFailure(
              "CALENDAR_FULL_RESYNC_MANAGED_EVENT_MISMATCH",
            );
          }
          continue;
        }

        const lookup = await getGoogleCalendarEvent({
          accessToken: input.accessToken,
          calendarId: input.calendarId,
          eventId,
          fetcher: input.fetcher,
        });
        if (lookup.kind === "found") {
          const classified = classifyGoogleCalendarEvent(
            lookup.event,
            input.calendarTimeZone,
          );
          if (classified.kind === "managed_mismatch") {
            throw calendarWorkerFailure(
              "CALENDAR_FULL_RESYNC_MANAGED_EVENT_MISMATCH",
            );
          }
          if (classified.kind !== "managed") {
            seenEventIds.add(eventId);
            await applyExternal(
              classifyGoogleCalendarEventAsExternal(
                lookup.event,
                input.calendarTimeZone,
              ),
            );
            continue;
          }
          if (
            classified.eventId !== eventId ||
            classified.appointmentId.toLowerCase() !== appointmentId
          ) {
            throw calendarWorkerFailure(
              "CALENDAR_FULL_RESYNC_MANAGED_EVENT_MISMATCH",
            );
          }
          const outcome = await observeManaged({
            ...classified,
            payloadFingerprintValid:
              await managedGoogleCalendarEventFingerprintIsValid(lookup.event),
          });
          if (outcome === "ignored_unknown_appointment") {
            // El GET confirma que el evento todavía existe aunque el turno haya
            // desaparecido durante el audit. Se conserva en la reconciliación
            // y se aplica por su forma externa bajo el mismo lease/generación.
            seenEventIds.add(eventId);
            await applyExternal(
              classifyGoogleCalendarEventAsExternal(
                lookup.event,
                input.calendarTimeZone,
              ),
            );
          } else {
            await retireExternalFallback(classified);
          }
        } else if (value.remote_known) {
          if (!input.automationEpoch) {
            throw calendarWorkerFailure(
              "CALENDAR_INBOUND_MANAGED_ASSOCIATION_MISSING",
            );
          }
          const outcome = await observeManaged({
            eventId,
            appointmentId,
            automationEpoch: input.automationEpoch,
            projectionStage: null,
            cancelled: true,
            startsAt: null,
            endsAt: null,
            updatedAt: null,
            etag: null,
            payloadFingerprintValid: false,
          });
          if (outcome === "ignored_unknown_appointment") {
            await applyExternal({
              kind: "external_removed",
              eventId,
              updatedAt: null,
              etag: null,
              removalReason: "cancelled",
            });
          } else {
            await retireExternalFallback({
              eventId,
              updatedAt: null,
              etag: null,
            });
          }
        }
      }

      afterAppointmentId = pageCursor;
      if (candidates.length < FULL_RESYNC_MANAGED_PAGE_SIZE) {
        managedAuditFinished = true;
        break;
      }
    }

    if (!managedAuditFinished) {
      throw calendarWorkerFailure(
        "CALENDAR_FULL_RESYNC_MANAGED_CANDIDATES_TRUNCATED",
      );
    }

    const { data, error } = await client.rpc(
      "reconcile_google_calendar_external_events",
      {
        p_expected_generation: generation,
        p_lease_token: leaseToken,
        p_seen_event_ids: [...seenEventIds],
      },
    );
    if (error) {
      // Sin reconciliar ausencias no se puede confirmar la ventana ni avanzar
      // el token: quedarían bloqueos eliminados ocupando turnos indefinidamente.
      throw calendarWorkerFailure("CALENDAR_INBOUND_RECONCILE_FAILED");
    }
    const removed = Number(data ?? 0);
    if (!Number.isSafeInteger(removed) || removed < 0) {
      throw calendarWorkerFailure("CALENDAR_INBOUND_RECONCILE_FAILED");
    }
    summary = {
      ...summary,
      blocksRemoved: summary.blocksRemoved + removed,
    };
  }

  return {
    ...summary,
    pagesFetched: pages,
    truncated: Boolean(pageToken),
    nextSyncToken: pageToken ? null : nextSyncToken,
  };
}

if (import.meta.main) {
  Deno.serve((request) => handleCalendarSyncRequest(request));
}
