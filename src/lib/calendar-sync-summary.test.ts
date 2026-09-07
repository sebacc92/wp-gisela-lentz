import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarSyncChangeCount,
  describeCalendarSync,
  emptyCalendarSyncSummary,
  formatSyncClock,
  parseCalendarSyncOutcome,
  parseCalendarSyncSummary,
} from "./calendar-sync-summary.ts";

test("el resumen descarta campos ajenos y valores no numéricos", () => {
  const summary = parseCalendarSyncSummary({
    pushed: 1,
    blocksImported: 2,
    failed: "muchos",
    conflictsOpened: -4,
    fullResync: true,
    patientName: "no debería estar",
  });
  assert.equal(summary.pushed, 1);
  assert.equal(summary.blocksImported, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.conflictsOpened, 0);
  assert.equal(summary.fullResync, true);
  assert.equal(
    Object.keys(summary).includes("patientName"),
    false,
    "el resumen nunca puede arrastrar datos de pacientes",
  );
});

test("una corrida sin novedades igual informa la hora de la revisión", () => {
  const message = describeCalendarSync({
    summary: emptyCalendarSyncSummary(),
    checkedAt: "2026-09-02T21:42:00.000Z",
  });
  assert.match(
    message,
    /^Sin cambios\. Calendario revisado a las \d{2}:\d{2}\.$/,
  );
});

test("el resumen visible informa enviados, importados y errores", () => {
  const message = describeCalendarSync({
    summary: {
      ...emptyCalendarSyncSummary(),
      pushed: 1,
      blocksImported: 1,
    },
    checkedAt: "2026-09-02T21:42:00.000Z",
  });
  assert.equal(
    message,
    "Sincronización completada: 1 enviado, 1 importado, 0 errores.",
  );
});

test("los conflictos y los eventos omitidos se comunican sin detalles", () => {
  const message = describeCalendarSync({
    summary: {
      ...emptyCalendarSyncSummary(),
      conflictsOpened: 2,
      skipped: 1,
    },
  });
  assert.match(message, /2 cambios para revisar/);
  assert.match(message, /1 evento omitido/);
});

test("un error se muestra sanitizado y sin asustar sobre la agenda", () => {
  const message = describeCalendarSync({
    summary: emptyCalendarSyncSummary(),
    error: "GOOGLE_EVENTS_LIST_FAILED",
  });
  assert.match(message, /No pudimos completar la revisión/);
  assert.equal(message.includes("GOOGLE_EVENTS_LIST_FAILED"), false);
});

test("la primera importación pendiente se explica, no se reporta como error", () => {
  const message = describeCalendarSync({
    summary: { ...emptyCalendarSyncSummary(), pushed: 1 },
    skippedReason: "FIRST_IMPORT_APPROVAL_REQUIRED",
  });
  assert.equal(
    message,
    "No enviamos turnos ni trajimos eventos esta vez. Para empezar de forma segura, falta aprobar la primera importación.",
  );
  assert.doesNotMatch(
    message,
    /turnos se enviaron/i,
    "un outcome omitido no puede afirmar que los contadores se ejecutaron",
  );
});

test("el contador de cambios ignora lo que ya estaba en sincronía", () => {
  assert.equal(
    calendarSyncChangeCount({
      ...emptyCalendarSyncSummary(),
      managedInSync: 5,
      blocksUnchanged: 3,
      skipped: 2,
    }),
    0,
  );
  assert.equal(
    calendarSyncChangeCount({
      ...emptyCalendarSyncSummary(),
      pushed: 1,
      blocksRemoved: 1,
    }),
    2,
  );
});

test("el reloj usa la zona horaria del consultorio", () => {
  assert.equal(formatSyncClock("2026-09-02T21:42:00.000Z"), "18:42");
  assert.equal(formatSyncClock("no-es-fecha"), "");
});

test("una ejecución parcial no se anuncia como sincronización completa", () => {
  const message = describeCalendarSync({
    summary: { ...emptyCalendarSyncSummary(), pushed: 1, retried: 2 },
    outcome: "partial",
    checkedAt: "2026-09-03T21:42:00.000Z",
  });
  assert.match(message, /incompleta/);
  assert.doesNotMatch(message, /completada/);
  assert.match(message, /se reintentan solos/);
});

test("una ejecución omitida por lease ocupado no se anuncia como exitosa", () => {
  const message = describeCalendarSync({
    summary: { ...emptyCalendarSyncSummary(), pushed: 1 },
    outcome: "skipped",
    skippedReason: "INBOUND_SYNC_IN_PROGRESS",
  });
  assert.match(message, /Ya había una sincronización en curso/);
  assert.doesNotMatch(message, /completada/);
});

test("el outcome del servidor manda sobre los contadores", () => {
  // Cero cambios y cero errores, pero el pull no llegó a terminar.
  const message = describeCalendarSync({
    summary: emptyCalendarSyncSummary(),
    outcome: "partial",
  });
  assert.doesNotMatch(message, /Sin cambios/);
  assert.match(message, /incompleta/);
});

test("los turnos reconocidos se distinguen de bloqueos y pendientes de completar", () => {
  const summary = parseCalendarSyncSummary({
    appointmentsImported: 1,
    patientImportsNeedReview: 2,
    patientImportsFailed: 0,
  });
  assert.equal(calendarSyncChangeCount(summary), 1);
  assert.match(describeCalendarSync({ summary }), /1 turno reconocido/);
  assert.match(
    describeCalendarSync({ summary }),
    /2 eventos de pacientes para completar/,
  );
  assert.match(
    describeCalendarSync({
      summary: { ...summary, patientImportsFailed: 1 },
    }),
    /Sincronización incompleta/,
  );
});

test("un outcome desconocido se trata como error, nunca como éxito", () => {
  assert.equal(parseCalendarSyncOutcome("todo bien"), "error");
  assert.equal(parseCalendarSyncOutcome(undefined), "error");
  assert.equal(parseCalendarSyncOutcome("completed"), "completed");
  assert.equal(parseCalendarSyncOutcome("skipped"), "skipped");
});
