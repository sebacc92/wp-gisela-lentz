import assert from "node:assert/strict";
import test from "node:test";
import { classifyGoogleCalendarEvent } from "../_shared/google-calendar.ts";
import {
  applyExternalEventOutcome,
  applyManagedEventOutcome,
  countClassifiedEvent,
  emptyInboundPreviewCounts,
  emptyInboundSyncSummary,
  GOOGLE_CALENDAR_COVERAGE_DAYS,
  googleCalendarCoverageWindow,
  inboundChangeCount,
  parseCalendarSyncMode,
  parseExternalEventRpcOutcome,
  parseManagedEventRpcOutcome,
  shouldImportExternalBlock,
} from "./inbound-policy.ts";

const now = new Date("2026-09-02T12:00:00.000Z");

test("sólo se aceptan los modos declarados de sincronización manual", () => {
  assert.equal(parseCalendarSyncMode("manual"), "manual");
  assert.equal(parseCalendarSyncMode("preview"), "preview");
  assert.equal(
    parseCalendarSyncMode("approve_first_import"),
    "approve_first_import",
  );
  assert.equal(parseCalendarSyncMode("initial_import"), "initial_import");
  assert.equal(parseCalendarSyncMode("automatic"), null);
  assert.equal(parseCalendarSyncMode(""), null);
  assert.equal(parseCalendarSyncMode(undefined), null);
});

test("un evento externo ya terminado no se importa como bloqueo", () => {
  assert.equal(
    shouldImportExternalBlock({
      endsAt: "2026-09-02T13:00:00.000Z",
      now,
    }),
    true,
  );
  assert.equal(
    shouldImportExternalBlock({
      endsAt: "2026-09-01T13:00:00.000Z",
      now,
    }),
    false,
  );
  assert.equal(
    shouldImportExternalBlock({ endsAt: "no-es-fecha", now }),
    false,
  );
});

test("el preview cuenta por categoría sin exponer ningún detalle", () => {
  const events = [
    {
      id: "gl8c4b7679f3b84bd898cba5a57a49b9e1",
      status: "confirmed",
      extendedProperties: {
        private: {
          managed_by: "gisela_lentz_agenda",
          appointment_id: "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1",
          automation_epoch: "11111111-1111-4111-8111-111111111111",
          projection_stage: "confirmed",
        },
      },
      start: { dateTime: "2026-09-04T14:00:00.000Z" },
      end: { dateTime: "2026-09-04T14:30:00.000Z" },
    },
    {
      id: "manual-future",
      summary: "Evento sintético de prueba",
      start: { dateTime: "2026-09-04T14:00:00.000Z" },
      end: { dateTime: "2026-09-04T15:00:00.000Z" },
    },
    {
      id: "manual-past",
      start: { dateTime: "2026-08-04T14:00:00.000Z" },
      end: { dateTime: "2026-08-04T15:00:00.000Z" },
    },
    {
      id: "manual-all-day",
      start: { date: "2026-09-05" },
      end: { date: "2026-09-06" },
    },
    { id: "manual-cancelled", status: "cancelled" },
    { status: "confirmed" },
  ];

  let counts = emptyInboundPreviewCounts();
  for (const event of events) {
    counts = countClassifiedEvent(
      counts,
      classifyGoogleCalendarEvent(event, "America/Argentina/Buenos_Aires"),
      now,
    );
  }

  assert.deepEqual(counts, {
    managed: 1,
    externalBlocks: 2,
    externalUnsupported: 0,
    externalRemoved: 1,
    ignored: 1,
    pastBlocks: 1,
  });
});

test("la cobertura usa 21 fechas locales y conserva el fin exclusivo", () => {
  const coverage = googleCalendarCoverageWindow(
    new Date("2026-09-05T02:30:00.000Z"),
    "America/Argentina/Buenos_Aires",
  );

  assert.deepEqual(coverage, {
    startsAt: "2026-09-04T03:00:00.000Z",
    endsAt: "2026-09-25T03:00:00.000Z",
    startDate: "2026-09-04",
    endDateExclusive: "2026-09-25",
    days: GOOGLE_CALENDAR_COVERAGE_DAYS,
    timeZone: "America/Argentina/Buenos_Aires",
  });
});

test("la cobertura se calcula por calendario aun atravesando un cambio DST", () => {
  const coverage = googleCalendarCoverageWindow(
    new Date("2026-03-07T17:00:00.000Z"),
    "America/New_York",
  );

  assert.equal(coverage?.startDate, "2026-03-07");
  assert.equal(coverage?.endDateExclusive, "2026-03-28");
  assert.equal(coverage?.startsAt, "2026-03-07T05:00:00.000Z");
  assert.equal(coverage?.endsAt, "2026-03-28T04:00:00.000Z");
});

test("el resumen sólo cuenta como cambio lo que realmente se aplicó", () => {
  let summary = emptyInboundSyncSummary();
  summary = applyExternalEventOutcome(summary, "created");
  summary = applyExternalEventOutcome(summary, "updated");
  summary = applyExternalEventOutcome(summary, "removed");
  summary = applyExternalEventOutcome(summary, "unchanged");
  summary = applyExternalEventOutcome(summary, "skipped_converted");
  summary = applyManagedEventOutcome(summary, "in_sync");
  summary = applyManagedEventOutcome(summary, "conflict_recorded");
  summary = applyManagedEventOutcome(summary, "pending_push");

  assert.equal(summary.blocksImported, 1);
  assert.equal(summary.blocksUpdated, 1);
  assert.equal(summary.blocksRemoved, 1);
  assert.equal(summary.blocksUnchanged, 1);
  assert.equal(summary.managedInSync, 1);
  assert.equal(summary.conflictsOpened, 1);
  assert.equal(summary.skipped, 2);
  // Un evento sin cambios y un evento administrado en sincronía no cuentan
  // como trabajo: importados + actualizados + retirados + conflictos.
  assert.equal(inboundChangeCount(summary), 4);
});

test("los outcomes RPC sólo aceptan el contrato actual exacto", () => {
  const external = [
    "created",
    "updated",
    "removed",
    "unchanged",
    "already_removed",
    "skipped_converted",
    "conflict_recorded",
    "conflict_pending",
  ];
  const managed = [
    "conflict_recorded",
    "conflict_pending",
    "in_sync",
    "pending_push",
    "ignored_unknown_appointment",
    "ignored_final_appointment",
    "ignored_invalid_range",
  ];
  for (const value of external) {
    assert.equal(parseExternalEventRpcOutcome(value), value);
  }
  for (const value of managed) {
    assert.equal(parseManagedEventRpcOutcome(value), value);
  }
  for (const value of [
    null,
    undefined,
    "",
    "created ",
    "ignored_pending_push",
    "unknown",
    true,
    1,
    {},
  ]) {
    assert.equal(parseExternalEventRpcOutcome(value), null);
    assert.equal(parseManagedEventRpcOutcome(value), null);
  }
});

test("los cambios en turnos importados abren revisión sin contar otro bloqueo", () => {
  const recorded = applyExternalEventOutcome(
    emptyInboundSyncSummary(),
    "conflict_recorded",
  );
  const pending = applyExternalEventOutcome(recorded, "conflict_pending");
  assert.equal(pending.conflictsOpened, 1);
  assert.equal(pending.blocksImported, 0);
  assert.equal(pending.blocksUpdated, 0);
  assert.equal(pending.blocksRemoved, 0);
  assert.equal(pending.skipped, 1);
  assert.equal(inboundChangeCount(pending), 1);
});

test("una corrida sin novedades no reporta ningún cambio", () => {
  const summary = emptyInboundSyncSummary();
  assert.equal(inboundChangeCount(summary), 0);
  assert.equal(summary.fullResync, false);
});
