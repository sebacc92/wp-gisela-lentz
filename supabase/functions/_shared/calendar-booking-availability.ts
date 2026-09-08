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
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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

const PROJECTION_WAIT_MS = 20_000;
const PROJECTION_POLL_MS = 500;
const PROJECTION_REFRESH_AFTER_MS = 2_000;

/**
 * The INSERT already starts a worker. Give it time to finish, then request at
 * most one refresh and keep checking this exact turn within the same budget.
 * A busy worker or a successful response for another turn is not confirmation.
 */
export async function ensureAppointmentCalendarProjection(input: {
  readProjection: (signal: AbortSignal) => Promise<unknown>;
  refresh: (signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<boolean> {
  const now = input.now ?? (() => performance.now());
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadline = startedAt + PROJECTION_WAIT_MS;
  const cleanup = new AbortController();
  const signal = AbortSignal.any([
    cleanup.signal,
    AbortSignal.timeout(PROJECTION_WAIT_MS),
  ]);
  let refreshTask: Promise<void> | null = null;

  try {
    while (now() < deadline && !signal.aborted) {
      const current = await input.readProjection(signal);
      if (now() >= deadline || signal.aborted) return false;
      if (isSyncedAppointmentCalendarProjection(current)) return true;
      if (
        !current ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        (current as { state?: unknown }).state !== "pending"
      )
        return false;

      const remaining = deadline - now();
      if (remaining <= 0 || signal.aborted) return false;
      if (!refreshTask && now() - startedAt >= PROJECTION_REFRESH_AFTER_MS) {
        // Keep polling while the worker responds: it may have synced this
        // turn already and still be processing other jobs in its batch.
        refreshTask = (async () => {
          try {
            await input.refresh(signal);
          } catch {
            // A lost response does not invalidate a verified projection.
          }
        })();
        continue;
      }
      await sleep(Math.min(PROJECTION_POLL_MS, remaining));
    }
  } catch {
    // A failed read never proves that the appointment was synchronized.
  } finally {
    // Stop and settle the client request; the durable server job can finish
    // independently. Never leave a floating fetch after this execution ends.
    cleanup.abort();
    await refreshTask;
  }
  return false;
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

const AVAILABILITY_REFRESH_WAIT_MS = 45_000;
const AVAILABILITY_REFRESH_RETRY_MS = 1_000;

function isCalendarAvailabilityRefreshBusy(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as CalendarAvailabilityRefreshResponse;
  return (
    response.processed === true &&
    response.mode === "automatic" &&
    response.outcome === "skipped" &&
    response.inbound !== null &&
    typeof response.inbound === "object" &&
    response.inbound.truncated === false &&
    response.inbound.skippedReason === "INBOUND_SYNC_IN_PROGRESS" &&
    response.inbound.error === null
  );
}

function waitForCalendarRefresh(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs the scheduler's inbound-first worker before a booking decision. The
 * database still verifies that the committed observation belongs to the
 * current WhatsApp execution; this response alone never authorizes a write.
 * A concurrent sync is transient: wait and obtain a complete refresh of our
 * own, within one deadline shared by all requests and waits. Never treat a
 * busy response as evidence of availability or retry an actual sync failure.
 */
export async function refreshCalendarAvailabilityBeforeBooking(
  input: CalendarAvailabilityRefreshInput,
): Promise<boolean> {
  const projectUrl = input.projectUrl?.trim().replace(/\/+$/, "") ?? "";
  const cronSecret = input.cronSecret?.trim() ?? "";
  if (!projectUrl || !cronSecret) return false;

  const now = input.now ?? (() => performance.now());
  const sleep = input.sleep ?? waitForCalendarRefresh;
  const deadline = now() + AVAILABILITY_REFRESH_WAIT_MS;
  const cleanup = new AbortController();
  const signal = AbortSignal.any([
    cleanup.signal,
    AbortSignal.timeout(AVAILABILITY_REFRESH_WAIT_MS),
    ...(input.signal ? [input.signal] : []),
  ]);

  try {
    while (now() < deadline && !signal.aborted) {
      const response = await (input.fetcher ?? fetch)(
        `${projectUrl}/functions/v1/process-calendar-sync`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-google-calendar-cron-secret": cronSecret,
          },
          body: "{}",
          signal,
        },
      );
      if (now() >= deadline || signal.aborted || !response.ok) return false;
      const result: unknown = await response.json();
      if (now() >= deadline || signal.aborted) return false;
      if (isCompleteCalendarAvailabilityRefresh(result)) return true;
      if (!isCalendarAvailabilityRefreshBusy(result)) return false;

      await sleep(
        Math.min(AVAILABILITY_REFRESH_RETRY_MS, deadline - now()),
        signal,
      );
    }
  } catch {
    // Cancellation, a lost response, or an unreadable result proves nothing.
    return false;
  } finally {
    cleanup.abort();
  }
  return false;
}
