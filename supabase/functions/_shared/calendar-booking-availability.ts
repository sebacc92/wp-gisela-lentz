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
