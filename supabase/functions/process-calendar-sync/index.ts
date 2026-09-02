import {
  classifyGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  deterministicGoogleEventId,
  googleOAuthConfiguration,
  GoogleIntegrationError,
  listGoogleCalendarEvents,
  refreshGoogleAccessToken,
  safeGoogleErrorCode,
  upsertGoogleCalendarEvent,
  type CalendarSyncAppointment,
} from "../_shared/google-calendar.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import {
  calendarJobFailureDecision,
  shouldCleanupInsertedCalendarEvent,
} from "./sync-policy.ts";
import {
  applyExternalEventOutcome,
  applyManagedEventOutcome,
  countClassifiedEvent,
  emptyInboundPreviewCounts,
  emptyInboundSyncSummary,
  inboundChangeCount,
  parseCalendarSyncMode,
  shouldImportExternalBlock,
  type CalendarSyncMode,
  type InboundSyncSummary,
} from "./inbound-policy.ts";

interface CalendarConnectionSecret {
  status?: string;
  google_calendar_id?: string;
  refresh_token?: string;
  connection_generation?: number | string;
}

interface CalendarSyncJob extends CalendarSyncAppointment {
  job_id: string;
  operation: "upsert" | "delete";
  desired_version: number | string;
  attempts: number | string;
  connection_generation: number | string;
}

interface ReconcileResult {
  queued?: number | string;
  already_queued?: number | string;
}

interface CalendarConnectionState {
  status?: string;
  connection_generation?: number | string;
}

interface InboundLease {
  lease_token?: string;
  sync_token?: string | null;
  sync_state?: string;
  first_import_approved?: boolean;
  google_calendar_id?: string;
}

const MAX_INBOUND_PAGES = 12;

function firstRow<T>(data: unknown): T | null {
  return (Array.isArray(data) ? data[0] : data) as T | null;
}

async function isAuthorizedInvocation(
  request: Request,
  client: ReturnType<typeof createServiceClient>,
): Promise<{ authorized: boolean; manual: boolean; userId: string | null }> {
  const providedCronSecret = request.headers
    .get("x-google-calendar-cron-secret")
    ?.trim();
  if (providedCronSecret) {
    const expectedCronSecret = Deno.env
      .get("GOOGLE_CALENDAR_CRON_SECRET")
      ?.trim();
    return {
      authorized: Boolean(
        expectedCronSecret && providedCronSecret === expectedCronSecret,
      ),
      manual: false,
      userId: null,
    };
  }

  try {
    const { profile } = await authorizeUser(request, client);
    return {
      authorized: profile.role === "ADMIN",
      manual: true,
      userId: profile.id,
    };
  } catch {
    return { authorized: false, manual: true, userId: null };
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const client = createServiceClient();
  const invocation = await isAuthorizedInvocation(request, client);
  if (!invocation.authorized) {
    return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
  }

  let mode: CalendarSyncMode = "manual";
  if (invocation.manual) {
    try {
      const input = (await request.json()) as { mode?: unknown };
      const parsed = parseCalendarSyncMode(input.mode);
      if (!parsed)
        return jsonResponse(request, { error: "INVALID_REQUEST" }, 400);
      mode = parsed;
    } catch {
      return jsonResponse(request, { error: "INVALID_REQUEST" }, 400);
    }
  }
  // El cron nunca hace preview ni aprueba la primera importación.
  const automatic = !invocation.manual;

  try {
    const config = googleOAuthConfiguration((name) => Deno.env.get(name));

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

    // El preview no debe tocar nada: ni cola saliente, ni lease, ni bitácora.
    let reconciliation: ReconcileResult | null = null;
    if (!preview) {
      const { data: reconcileData, error: reconcileError } = await client.rpc(
        "reconcile_google_calendar_sync",
        {},
      );
      if (reconcileError) throw new Error("CALENDAR_RECONCILIATION_FAILED");
      reconciliation = firstRow<ReconcileResult>(reconcileData);
    }

    const { data: connectionData, error: connectionError } = await client.rpc(
      "get_google_calendar_connection_secret",
      {},
    );
    if (connectionError) throw new Error("CALENDAR_CONNECTION_UNAVAILABLE");
    const connection = firstRow<CalendarConnectionSecret>(connectionData);
    if (
      !connection ||
      connection.status !== "connected" ||
      !connection.google_calendar_id ||
      !connection.refresh_token ||
      !Number.isSafeInteger(Number(connection.connection_generation))
    ) {
      return jsonResponse(request, {
        processed: false,
        ignored: true,
        reason:
          connection?.status === "reconnect_required"
            ? "RECONNECT_REQUIRED"
            : "NOT_CONNECTED",
      });
    }
    const generation = connection.connection_generation as number;

    let accessToken: string;
    try {
      const token = await refreshGoogleAccessToken({
        refreshToken: connection.refresh_token,
        config,
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
          reconnectRequired: true,
        });
      }
      throw error;
    }

    // -----------------------------------------------------------------------
    // Preview: sólo cuenta. Cero escrituras, en Google y en la base.
    // -----------------------------------------------------------------------
    if (preview) {
      const now = new Date();
      let counts = emptyInboundPreviewCounts();
      let pageToken: string | null = null;
      let pages = 0;
      do {
        const page = await listGoogleCalendarEvents({
          accessToken,
          calendarId: connection.google_calendar_id,
          pageToken,
          fetcher: fetch,
        });
        pages += 1;
        for (const item of page.items) {
          counts = countClassifiedEvent(
            counts,
            classifyGoogleCalendarEvent(item),
            now,
          );
        }
        pageToken = page.nextPageToken;
      } while (pageToken && pages < MAX_INBOUND_PAGES);

      return jsonResponse(request, {
        processed: true,
        mode: "preview",
        mutated: false,
        pagesFetched: pages,
        truncated: Boolean(pageToken),
        preview: {
          managedEvents: counts.managed,
          externalEvents: counts.externalBlocks + counts.pastBlocks,
          wouldBecomeBlocks: counts.externalBlocks,
          pastEventsIgnored: counts.pastBlocks,
          unsupportedEvents: counts.externalUnsupported,
          cancelledEvents: counts.externalRemoved,
          ignoredEvents: counts.ignored,
        },
      });
    }

    // -----------------------------------------------------------------------
    // Salida: App -> Google (comportamiento existente, con contadores propios)
    // -----------------------------------------------------------------------
    const { data: claimedData, error: claimError } = await client.rpc(
      "claim_google_calendar_sync_jobs",
      // Tres jobs mantienen la invocación bajo el límite incluso si cada
      // operación necesita POST+PATCH y consume su timeout de red.
      { p_limit: 3, p_expected_generation: generation },
    );
    if (claimError) throw new Error("CALENDAR_CLAIM_FAILED");
    const jobs = (claimedData ?? []) as CalendarSyncJob[];

    let synced = 0;
    let inserted = 0;
    let patched = 0;
    let deleted = 0;
    let retried = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        const eventId = deterministicGoogleEventId(job.appointment_id);
        let externalUpsertOperation: "inserted" | "patched" | null = null;
        if (job.operation === "delete") {
          await deleteGoogleCalendarEvent({
            accessToken,
            calendarId: connection.google_calendar_id,
            appointmentId: job.appointment_id,
          });
        } else if (job.operation === "upsert") {
          const upsertResult = await upsertGoogleCalendarEvent({
            accessToken,
            calendarId: connection.google_calendar_id,
            appointment: job,
          });
          externalUpsertOperation = upsertResult.operation;
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
          },
        );
        if (completeError) {
          throw new GoogleIntegrationError("CALENDAR_JOB_COMPLETE_FAILED", {
            status: 503,
            retryable: true,
          });
        }
        if (completed !== true) {
          // El turno o la conexión cambió mientras Google respondía. La cola
          // conserva la versión nueva. Una cancelación libera un delete
          // determinístico; una desconexión/generación nueva limpia sólo una
          // inserción recién creada, nunca un evento preexistente parcheado.
          if (externalUpsertOperation === "inserted") {
            const { data: currentConnection, error: currentConnectionError } =
              await client
                .from("google_calendar_connections")
                .select("status,connection_generation")
                .eq("id", true)
                .maybeSingle();
            if (
              !currentConnectionError &&
              shouldCleanupInsertedCalendarEvent({
                externalOperation: externalUpsertOperation,
                completed: false,
                claimedGeneration: job.connection_generation,
                currentConnectionStatus: (
                  currentConnection as CalendarConnectionState | null
                )?.status,
                currentConnectionGeneration: (
                  currentConnection as CalendarConnectionState | null
                )?.connection_generation,
              })
            ) {
              try {
                await deleteGoogleCalendarEvent({
                  accessToken,
                  calendarId: connection.google_calendar_id,
                  appointmentId: job.appointment_id,
                });
              } catch {
                console.warn(
                  "process-calendar-sync",
                  "STALE_INSERT_CLEANUP_FAILED",
                );
              }
            }
          }
          continue;
        }
        if (job.operation === "delete") deleted += 1;
        else {
          synced += 1;
          if (externalUpsertOperation === "inserted") inserted += 1;
          else patched += 1;
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
          },
        );
        if (failError) {
          console.error("process-calendar-sync", "CALENDAR_JOB_FAIL_FAILED");
        }
        if (!decision.terminal) retried += 1;
        else failed += 1;
      }
    }

    // -----------------------------------------------------------------------
    // Entrada: Google -> App
    // -----------------------------------------------------------------------
    let inbound: InboundRunResult = {
      ...emptyInboundSyncSummary(),
      nextSyncToken: null,
    };
    let inboundSkippedReason: string | null = null;
    let inboundError: string | null = null;
    let leaseToken: string | null = null;

    const { data: leaseData, error: leaseError } = await client.rpc(
      "begin_google_calendar_inbound_sync",
      { p_expected_generation: generation, p_lease_seconds: 240 },
    );
    if (leaseError) throw new Error("CALENDAR_INBOUND_LEASE_FAILED");
    const lease = firstRow<InboundLease>(leaseData);

    if (!lease?.lease_token) {
      // Otra ejecución ya está procesando esta conexión.
      inboundSkippedReason = "INBOUND_SYNC_IN_PROGRESS";
    } else if (!lease.sync_token && lease.first_import_approved !== true) {
      // La primera importación necesita una aprobación ADMIN explícita.
      inboundSkippedReason = "FIRST_IMPORT_APPROVAL_REQUIRED";
      await client.rpc("release_google_calendar_inbound_lease", {
        p_expected_generation: generation,
        p_lease_token: lease.lease_token,
      });
    } else {
      leaseToken = lease.lease_token;
      try {
        inbound = await runInboundSync({
          client,
          accessToken,
          calendarId: connection.google_calendar_id,
          generation,
          leaseToken,
          syncToken: lease.sync_token ?? null,
        });
      } catch (error) {
        // El lease se conserva para cerrar la corrida con el resumen completo,
        // incluido lo que sí llegó a Google en la parte saliente.
        inboundError = safeGoogleErrorCode(error);
      }
    }

    const summary = {
      pushed: inserted,
      updatedInGoogle: patched,
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

    // La revisión se registra aunque no haya habido un solo cambio. Ése era el
    // motivo por el que «Última sincronización» no se movía nunca.
    const changes = synced + deleted + inboundChangeCount(inbound);
    if (leaseToken && inboundError) {
      await client.rpc("fail_google_calendar_inbound_sync", {
        p_expected_generation: generation,
        p_lease_token: leaseToken,
        p_error_code: inboundError,
        p_summary: summary,
      });
    } else if (leaseToken) {
      await client.rpc("complete_google_calendar_inbound_sync", {
        p_expected_generation: generation,
        p_lease_token: leaseToken,
        p_next_sync_token: inbound.nextSyncToken,
        p_summary: summary,
        p_changes: changes,
      });
    } else {
      // Sin lease no hubo pull, pero la revisión existió igual.
      await client.rpc("record_google_calendar_sync_attempt", {
        p_expected_generation: generation,
        p_summary: summary,
        p_changes: changes,
        p_note: null,
      });
    }

    return jsonResponse(request, {
      processed: true,
      mode: automatic ? "automatic" : "manual",
      reconciliation: {
        queued: Number(reconciliation?.queued ?? 0),
        alreadyQueued: Number(reconciliation?.already_queued ?? 0),
      },
      claimed: jobs.length,
      synced,
      deleted,
      retried,
      failed,
      inbound: {
        ...summary,
        skippedReason: inboundSkippedReason,
        error: inboundError,
      },
      summary,
    });
  } catch (error) {
    const code = safeGoogleErrorCode(error);
    console.error("process-calendar-sync", code);
    return jsonResponse(
      request,
      {
        error: code,
        message: "No pudimos completar la sincronización con Google Calendar.",
      },
      503,
    );
  }
});

interface InboundRunResult extends InboundSyncSummary {
  nextSyncToken: string | null;
}

async function runInboundSync(input: {
  client: ReturnType<typeof createServiceClient>;
  accessToken: string;
  calendarId: string;
  generation: number;
  leaseToken: string;
  syncToken: string | null;
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
      await client.rpc("invalidate_google_calendar_sync_token", {
        p_expected_generation: generation,
        p_lease_token: leaseToken,
      });
      syncToken = null;
      attemptedFullResync = true;
    }
  }
  throw new GoogleIntegrationError("GOOGLE_SYNC_TOKEN_EXPIRED", {
    status: 410,
  });
}

async function pullGoogleCalendar(input: {
  client: ReturnType<typeof createServiceClient>;
  accessToken: string;
  calendarId: string;
  generation: number;
  leaseToken: string;
  syncToken: string | null;
}): Promise<InboundRunResult> {
  const { client, generation, leaseToken } = input;
  const now = new Date();
  const fullResync = input.syncToken === null;
  let summary = emptyInboundSyncSummary();
  summary = { ...summary, fullResync };

  const seenEventIds: string[] = [];
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;
  let pages = 0;

  do {
    // Google pide repetir el mismo juego de parámetros en cada página, así que
    // el syncToken viaja también junto al pageToken.
    const page = await listGoogleCalendarEvents({
      accessToken: input.accessToken,
      calendarId: input.calendarId,
      syncToken: input.syncToken,
      pageToken,
      fetcher: fetch,
    });
    pages += 1;

    for (const item of page.items) {
      const classified = classifyGoogleCalendarEvent(item);
      if (classified.kind === "ignored") {
        summary = { ...summary, skipped: summary.skipped + 1 };
        continue;
      }
      seenEventIds.push(classified.eventId);

      if (classified.kind === "managed") {
        const { data, error } = await client.rpc(
          "observe_google_calendar_managed_event",
          {
            p_expected_generation: generation,
            p_lease_token: leaseToken,
            p_google_event_id: classified.eventId,
            p_appointment_id: classified.appointmentId,
            p_cancelled: classified.cancelled,
            p_starts_at: classified.startsAt,
            p_ends_at: classified.endsAt,
            p_google_updated_at: classified.updatedAt,
          },
        );
        if (error) throw new Error("CALENDAR_INBOUND_OBSERVE_FAILED");
        summary = applyManagedEventOutcome(summary, String(data ?? ""));
        continue;
      }

      if (
        classified.kind === "external_block" &&
        !shouldImportExternalBlock({ endsAt: classified.endsAt, now })
      ) {
        summary = { ...summary, skipped: summary.skipped + 1 };
        continue;
      }

      const removed = classified.kind === "external_removed";
      const { data, error } = await client.rpc(
        "apply_google_calendar_external_event",
        {
          p_expected_generation: generation,
          p_lease_token: leaseToken,
          p_google_event_id: classified.eventId,
          p_kind:
            classified.kind === "external_block" ? "block" : "unsupported",
          p_removed: removed,
          p_summary: removed ? null : (classified.summary ?? null),
          p_starts_at:
            classified.kind === "external_block" ? classified.startsAt : null,
          p_ends_at:
            classified.kind === "external_block" ? classified.endsAt : null,
          p_all_day:
            classified.kind === "external_unsupported" &&
            classified.reason === "ALL_DAY",
          p_recurring:
            classified.kind === "external_unsupported" &&
            classified.reason === "RECURRING",
          p_unsupported_reason:
            classified.kind === "external_unsupported"
              ? classified.reason
              : null,
          p_google_etag: removed ? null : (classified.etag ?? null),
          p_google_updated_at: classified.updatedAt,
        },
      );
      if (error) {
        // Un evento con un formato que no entendemos no puede romper el lote.
        console.warn("process-calendar-sync", "EXTERNAL_EVENT_SKIPPED");
        summary = { ...summary, skipped: summary.skipped + 1 };
        continue;
      }
      summary = applyExternalEventOutcome(summary, String(data ?? ""));
    }

    pageToken = page.nextPageToken;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken && pages < MAX_INBOUND_PAGES);

  // Sólo una corrida completa sabe qué eventos ya no existen. El token nuevo se
  // guarda únicamente cuando se recorrieron todas las páginas.
  if (fullResync && !pageToken) {
    const { data, error } = await client.rpc(
      "reconcile_google_calendar_external_events",
      {
        p_expected_generation: generation,
        p_lease_token: leaseToken,
        p_seen_event_ids: seenEventIds,
      },
    );
    if (!error) {
      summary = {
        ...summary,
        blocksRemoved: summary.blocksRemoved + Number(data ?? 0),
      };
    }
  }

  return {
    ...summary,
    pagesFetched: pages,
    nextSyncToken: pageToken ? null : nextSyncToken,
  };
}
