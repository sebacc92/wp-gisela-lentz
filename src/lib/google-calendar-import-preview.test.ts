import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCalendarImportPreview,
  sameCalendarImportPreview,
  type CalendarImportPreview,
} from "./google-calendar-import-preview.ts";

function response(
  overrides: Partial<CalendarImportPreview> = {},
): Record<string, unknown> {
  const preview: CalendarImportPreview = {
    managedEvents: 1,
    legacyManagedEvents: 2,
    externalEvents: 3,
    recurringSeries: 2,
    recurringOccurrences: 7,
    cancelledRecurringOccurrences: 1,
    allDayEvents: 2,
    freeEventsIgnored: 1,
    wouldBecomeBlocks: 5,
    unsupportedEvents: 0,
    pastEventsIgnored: 0,
    truncated: false,
    coverageStartDate: "2026-09-05",
    coverageEndDateExclusive: "2026-09-26",
    coverageDays: 21,
    calendarTimeZone: "America/Argentina/Buenos_Aires",
    ...overrides,
  };
  const {
    truncated,
    coverageStartDate,
    coverageEndDateExclusive,
    coverageDays,
    calendarTimeZone,
    ...counts
  } = preview;
  return {
    processed: true,
    mutated: false,
    mode: "preview",
    outcome: "completed",
    truncated,
    coverage: {
      startDate: coverageStartDate,
      endDateExclusive: coverageEndDateExclusive,
      days: coverageDays,
      timeZone: calendarTimeZone,
    },
    preview: counts,
  };
}

test("el preview exige el conteo separado de integraciones anteriores", () => {
  const valid = parseCalendarImportPreview(response());
  assert.deepEqual(valid, {
    managedEvents: 1,
    legacyManagedEvents: 2,
    externalEvents: 3,
    recurringSeries: 2,
    recurringOccurrences: 7,
    cancelledRecurringOccurrences: 1,
    allDayEvents: 2,
    freeEventsIgnored: 1,
    wouldBecomeBlocks: 5,
    unsupportedEvents: 0,
    pastEventsIgnored: 0,
    truncated: false,
    coverageStartDate: "2026-09-05",
    coverageEndDateExclusive: "2026-09-26",
    coverageDays: 21,
    calendarTimeZone: "America/Argentina/Buenos_Aires",
  });

  const missingLegacy = response();
  delete (missingLegacy.preview as Record<string, unknown>).legacyManagedEvents;
  assert.equal(parseCalendarImportPreview(missingLegacy), null);
});

test("el snapshot detecta cualquier cambio de alcance antes de aprobar", () => {
  const original = parseCalendarImportPreview(response());
  assert.ok(original);

  for (const changed of [
    { managedEvents: 2 },
    { legacyManagedEvents: 3 },
    { externalEvents: 4 },
    { recurringSeries: 3 },
    { recurringOccurrences: 8 },
    { cancelledRecurringOccurrences: 2 },
    { allDayEvents: 3 },
    { freeEventsIgnored: 2 },
    { wouldBecomeBlocks: 6 },
    { unsupportedEvents: 1 },
    { pastEventsIgnored: 1 },
    { truncated: true },
    { calendarTimeZone: "America/Montevideo" },
    {
      coverageStartDate: "2026-09-06",
      coverageEndDateExclusive: "2026-09-27",
    },
    { coverageEndDateExclusive: "2026-09-27", coverageDays: 22 },
  ]) {
    const latest = parseCalendarImportPreview(response(changed));
    assert.ok(latest);
    assert.equal(sameCalendarImportPreview(original, latest), false);
  }
  assert.equal(
    sameCalendarImportPreview(
      original,
      parseCalendarImportPreview(response()) as CalendarImportPreview,
    ),
    true,
  );
});

test("el preview rechaza respuestas mutantes, incompletas o con conteos inválidos", () => {
  assert.equal(
    parseCalendarImportPreview({ ...response(), mutated: true }),
    null,
  );
  assert.equal(
    parseCalendarImportPreview({ ...response(), outcome: "partial" }),
    null,
  );
  assert.equal(
    parseCalendarImportPreview(response({ wouldBecomeBlocks: -1 })),
    null,
  );
  assert.equal(
    parseCalendarImportPreview(
      response({ coverageEndDateExclusive: "2026-09-25" }),
    ),
    null,
  );
});
