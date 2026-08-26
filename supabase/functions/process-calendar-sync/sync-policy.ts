import {
  googleErrorRetryable,
  retryDelaySeconds,
  safeGoogleErrorCode,
} from "../_shared/google-calendar.ts";

export interface CalendarJobFailureDecision {
  errorCode: string;
  terminal: boolean;
  retryAt: string;
}

export function shouldCleanupInsertedCalendarEvent(args: {
  externalOperation: "inserted" | "patched" | null;
  completed: boolean;
  claimedGeneration: number | string;
  currentConnectionStatus?: string | null;
  currentConnectionGeneration?: number | string | null;
}): boolean {
  if (args.externalOperation !== "inserted" || args.completed) return false;
  const claimedGeneration = Number(args.claimedGeneration);
  const currentGeneration = Number(args.currentConnectionGeneration);
  return (
    args.currentConnectionStatus !== "connected" ||
    !Number.isSafeInteger(claimedGeneration) ||
    !Number.isSafeInteger(currentGeneration) ||
    claimedGeneration !== currentGeneration
  );
}

export function calendarJobFailureDecision(
  error: unknown,
  attemptsValue: number | string,
  now = new Date(),
): CalendarJobFailureDecision {
  const attempts = Math.max(1, Number(attemptsValue) || 1);
  const retryable = googleErrorRetryable(error) && attempts < 8;
  return {
    errorCode: safeGoogleErrorCode(error),
    terminal: !retryable,
    retryAt: retryable
      ? new Date(
          now.getTime() + retryDelaySeconds(attempts) * 1000,
        ).toISOString()
      : now.toISOString(),
  };
}
