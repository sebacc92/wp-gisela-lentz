interface CalendarAvailabilityRefreshResponse {
  processed?: unknown;
  mode?: unknown;
  outcome?: unknown;
  inbound?: {
    truncated?: unknown;
    skippedReason?: unknown;
    error?: unknown;
  } | null;
}

export interface CalendarAvailabilityRefreshInput {
  projectUrl: string | undefined;
  cronSecret: string | undefined;
  fetcher?: typeof fetch;
}

export function isSyncedAppointmentCalendarProjection(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const projection = value as { state?: unknown; projectionStage?: unknown };
  return (
    projection.state === "synced" &&
    (projection.projectionStage === "pre_reservation" ||
      projection.projectionStage === "confirmed")
  );
}

/** A queue entry or a successful worker response is not proof of this turn. */
export async function ensureAppointmentCalendarProjection(input: {
  readProjection: () => Promise<unknown>;
  refresh: () => Promise<boolean>;
}): Promise<boolean> {
  try {
    const current = await input.readProjection();
    if (isSyncedAppointmentCalendarProjection(current)) return true;
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      (current as { state?: unknown }).state !== "pending"
    )
      return false;
    try {
      await input.refresh();
    } catch {
      // Recover an acknowledgment lost after the worker committed the job.
    }
    // A response may be lost after Google and the DB accepted this exact job.
    // Conversely, a successful refresh may have processed unrelated jobs only.
    return isSyncedAppointmentCalendarProjection(await input.readProjection());
  } catch {
    return false;
  }
}

export function isCompleteCalendarAvailabilityRefresh(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as CalendarAvailabilityRefreshResponse;
  return (
    response.processed === true &&
    response.mode === "automatic" &&
    response.outcome === "completed" &&
    response.inbound !== null &&
    typeof response.inbound === "object" &&
    response.inbound.truncated === false &&
    response.inbound.skippedReason === null &&
    response.inbound.error === null
  );
}

/**
 * Runs the scheduler's inbound-first worker before a booking decision. The
 * database still verifies that the committed observation belongs to the
 * current WhatsApp execution; this response alone never authorizes a write.
 */
export async function refreshCalendarAvailabilityBeforeBooking(
  input: CalendarAvailabilityRefreshInput,
): Promise<boolean> {
  const projectUrl = input.projectUrl?.trim().replace(/\/+$/, "") ?? "";
  const cronSecret = input.cronSecret?.trim() ?? "";
  if (!projectUrl || !cronSecret) return false;

  try {
    const response = await (input.fetcher ?? fetch)(
      `${projectUrl}/functions/v1/process-calendar-sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-google-calendar-cron-secret": cronSecret,
        },
        body: "{}",
        signal: AbortSignal.timeout(45_000),
      },
    );
    if (!response.ok) return false;
    return isCompleteCalendarAvailabilityRefresh(await response.json());
  } catch {
    return false;
  }
}
