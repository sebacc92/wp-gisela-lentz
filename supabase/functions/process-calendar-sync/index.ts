import {
  deleteGoogleCalendarEvent,
  deterministicGoogleEventId,
  googleOAuthConfiguration,
  GoogleIntegrationError,
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

function firstRow<T>(data: unknown): T | null {
  return (Array.isArray(data) ? data[0] : data) as T | null;
}

async function isAuthorizedInvocation(
  request: Request,
  client: ReturnType<typeof createServiceClient>,
): Promise<{ authorized: boolean; manual: boolean }> {
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
    };
  }

  try {
    const { profile } = await authorizeUser(request, client);
    return { authorized: profile.role === "ADMIN", manual: true };
  } catch {
    return { authorized: false, manual: true };
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

  if (invocation.manual) {
    try {
      const input = (await request.json()) as { mode?: string };
      if (input.mode !== "manual") {
        return jsonResponse(request, { error: "INVALID_REQUEST" }, 400);
      }
    } catch {
      return jsonResponse(request, { error: "INVALID_REQUEST" }, 400);
    }
  }

  try {
    const config = googleOAuthConfiguration((name) => Deno.env.get(name));
    const { data: reconcileData, error: reconcileError } = await client.rpc(
      "reconcile_google_calendar_sync",
      {},
    );
    if (reconcileError) throw new Error("CALENDAR_RECONCILIATION_FAILED");
    const reconciliation = firstRow<ReconcileResult>(reconcileData);

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
          p_expected_generation: connection.connection_generation,
        });
        return jsonResponse(request, {
          processed: false,
          reconnectRequired: true,
        });
      }
      throw error;
    }

    const { data: claimedData, error: claimError } = await client.rpc(
      "claim_google_calendar_sync_jobs",
      // Tres jobs mantienen la invocación bajo el límite incluso si cada
      // operación necesita POST+PATCH y consume su timeout de red.
      {
        p_limit: 3,
        p_expected_generation: connection.connection_generation,
      },
    );
    if (claimError) throw new Error("CALENDAR_CLAIM_FAILED");
    const jobs = (claimedData ?? []) as CalendarSyncJob[];

    let synced = 0;
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
        else synced += 1;
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

    return jsonResponse(request, {
      processed: true,
      mode: invocation.manual ? "manual" : "automatic",
      reconciliation: {
        queued: Number(reconciliation?.queued ?? 0),
        alreadyQueued: Number(reconciliation?.already_queued ?? 0),
      },
      claimed: jobs.length,
      synced,
      deleted,
      retried,
      failed,
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
