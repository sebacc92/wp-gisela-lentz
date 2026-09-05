export interface CalendarImportPreview {
  managedEvents: number;
  legacyManagedEvents: number;
  externalEvents: number;
  recurringSeries: number;
  recurringOccurrences: number;
  cancelledRecurringOccurrences: number;
  allDayEvents: number;
  freeEventsIgnored: number;
  wouldBecomeBlocks: number;
  unsupportedEvents: number;
  pastEventsIgnored: number;
  truncated: boolean;
  coverageStartDate: string;
  coverageEndDateExclusive: string;
  coverageDays: number;
  calendarTimeZone: string;
}

function previewCount(
  source: Record<string, unknown>,
  name: string,
): number | null {
  const candidate = source[name];
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
    ? candidate
    : null;
}

export function parseCalendarImportPreview(
  value: unknown,
): CalendarImportPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const preview = response.preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    return null;
  }

  const counts = preview as Record<string, unknown>;
  const coverage = response.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    return null;
  }
  const coverageRecord = coverage as Record<string, unknown>;
  const managedEvents = previewCount(counts, "managedEvents");
  const legacyManagedEvents = previewCount(counts, "legacyManagedEvents");
  const externalEvents = previewCount(counts, "externalEvents");
  const recurringSeries = previewCount(counts, "recurringSeries");
  const recurringOccurrences = previewCount(counts, "recurringOccurrences");
  const cancelledRecurringOccurrences = previewCount(
    counts,
    "cancelledRecurringOccurrences",
  );
  const allDayEvents = previewCount(counts, "allDayEvents");
  const freeEventsIgnored = previewCount(counts, "freeEventsIgnored");
  const wouldBecomeBlocks = previewCount(counts, "wouldBecomeBlocks");
  const unsupportedEvents = previewCount(counts, "unsupportedEvents");
  const pastEventsIgnored = previewCount(counts, "pastEventsIgnored");
  const coverageStartDate = coverageRecord.startDate;
  const coverageEndDateExclusive = coverageRecord.endDateExclusive;
  const coverageDays = coverageRecord.days;
  const calendarTimeZone = coverageRecord.timeZone;
  const parsedCoverageDays =
    typeof coverageStartDate === "string" &&
    typeof coverageEndDateExclusive === "string"
      ? (Date.parse(`${coverageEndDateExclusive}T00:00:00.000Z`) -
          Date.parse(`${coverageStartDate}T00:00:00.000Z`)) /
        86_400_000
      : Number.NaN;

  if (
    response.processed !== true ||
    response.mutated !== false ||
    response.mode !== "preview" ||
    response.outcome !== "completed" ||
    typeof response.truncated !== "boolean" ||
    managedEvents === null ||
    legacyManagedEvents === null ||
    externalEvents === null ||
    recurringSeries === null ||
    recurringOccurrences === null ||
    cancelledRecurringOccurrences === null ||
    allDayEvents === null ||
    freeEventsIgnored === null ||
    wouldBecomeBlocks === null ||
    unsupportedEvents === null ||
    pastEventsIgnored === null ||
    typeof coverageStartDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(coverageStartDate) ||
    typeof coverageEndDateExclusive !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(coverageEndDateExclusive) ||
    typeof coverageDays !== "number" ||
    !Number.isSafeInteger(coverageDays) ||
    coverageDays < 1 ||
    coverageDays > 366 ||
    parsedCoverageDays !== coverageDays ||
    typeof calendarTimeZone !== "string" ||
    !calendarTimeZone.trim() ||
    calendarTimeZone.length > 255
  ) {
    return null;
  }

  return {
    managedEvents,
    legacyManagedEvents,
    externalEvents,
    recurringSeries,
    recurringOccurrences,
    cancelledRecurringOccurrences,
    allDayEvents,
    freeEventsIgnored,
    wouldBecomeBlocks,
    unsupportedEvents,
    pastEventsIgnored,
    truncated: response.truncated,
    coverageStartDate,
    coverageEndDateExclusive,
    coverageDays,
    calendarTimeZone,
  };
}

export function sameCalendarImportPreview(
  left: CalendarImportPreview,
  right: CalendarImportPreview,
): boolean {
  return (
    left.managedEvents === right.managedEvents &&
    left.legacyManagedEvents === right.legacyManagedEvents &&
    left.externalEvents === right.externalEvents &&
    left.recurringSeries === right.recurringSeries &&
    left.recurringOccurrences === right.recurringOccurrences &&
    left.cancelledRecurringOccurrences ===
      right.cancelledRecurringOccurrences &&
    left.allDayEvents === right.allDayEvents &&
    left.freeEventsIgnored === right.freeEventsIgnored &&
    left.wouldBecomeBlocks === right.wouldBecomeBlocks &&
    left.unsupportedEvents === right.unsupportedEvents &&
    left.pastEventsIgnored === right.pastEventsIgnored &&
    left.truncated === right.truncated &&
    left.coverageStartDate === right.coverageStartDate &&
    left.coverageEndDateExclusive === right.coverageEndDateExclusive &&
    left.coverageDays === right.coverageDays &&
    left.calendarTimeZone === right.calendarTimeZone
  );
}
