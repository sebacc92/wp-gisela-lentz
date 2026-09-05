export interface CalendarImportPreview {
  managedEvents: number;
  legacyManagedEvents: number;
  externalEvents: number;
  wouldBecomeBlocks: number;
  unsupportedEvents: number;
  pastEventsIgnored: number;
  truncated: boolean;
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
  const managedEvents = previewCount(counts, "managedEvents");
  const legacyManagedEvents = previewCount(counts, "legacyManagedEvents");
  const externalEvents = previewCount(counts, "externalEvents");
  const wouldBecomeBlocks = previewCount(counts, "wouldBecomeBlocks");
  const unsupportedEvents = previewCount(counts, "unsupportedEvents");
  const pastEventsIgnored = previewCount(counts, "pastEventsIgnored");

  if (
    response.processed !== true ||
    response.mutated !== false ||
    response.mode !== "preview" ||
    response.outcome !== "completed" ||
    typeof response.truncated !== "boolean" ||
    managedEvents === null ||
    legacyManagedEvents === null ||
    externalEvents === null ||
    wouldBecomeBlocks === null ||
    unsupportedEvents === null ||
    pastEventsIgnored === null
  ) {
    return null;
  }

  return {
    managedEvents,
    legacyManagedEvents,
    externalEvents,
    wouldBecomeBlocks,
    unsupportedEvents,
    pastEventsIgnored,
    truncated: response.truncated,
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
    left.wouldBecomeBlocks === right.wouldBecomeBlocks &&
    left.unsupportedEvents === right.unsupportedEvents &&
    left.pastEventsIgnored === right.pastEventsIgnored &&
    left.truncated === right.truncated
  );
}
