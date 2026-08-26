import assert from "node:assert/strict";
import test from "node:test";
import { GoogleIntegrationError } from "../_shared/google-calendar.ts";
import {
  calendarJobFailureDecision,
  shouldCleanupInsertedCalendarEvent,
} from "./sync-policy.ts";

test("un error transitorio usa backoff y conserva el job", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");
  const decision = calendarJobFailureDecision(
    new GoogleIntegrationError("CALENDAR_JOB_COMPLETE_FAILED", {
      retryable: true,
    }),
    2,
    now,
  );
  assert.deepEqual(decision, {
    errorCode: "CALENDAR_JOB_COMPLETE_FAILED",
    terminal: false,
    retryAt: "2026-08-12T12:01:00.000Z",
  });
});

test("los reintentos tienen un límite para no dejar jobs eternos", () => {
  const decision = calendarJobFailureDecision(
    new GoogleIntegrationError("GOOGLE_EVENT_TOMBSTONED", {
      retryable: true,
    }),
    8,
    new Date("2026-08-12T12:00:00.000Z"),
  );
  assert.equal(decision.terminal, true);
  assert.equal(decision.errorCode, "GOOGLE_EVENT_TOMBSTONED");
});

test("un error desconocido no filtra detalles y queda terminal", () => {
  const decision = calendarJobFailureDecision(
    new Error("token o dato privado"),
    1,
    new Date("2026-08-12T12:00:00.000Z"),
  );
  assert.equal(decision.terminal, true);
  assert.equal(decision.errorCode, "GOOGLE_SYNC_FAILED");
});

test("sólo limpia una inserción huérfana si la conexión cambió o se cerró", () => {
  assert.equal(
    shouldCleanupInsertedCalendarEvent({
      externalOperation: "inserted",
      completed: false,
      claimedGeneration: 4,
      currentConnectionStatus: "disconnected",
      currentConnectionGeneration: 5,
    }),
    true,
  );
  assert.equal(
    shouldCleanupInsertedCalendarEvent({
      externalOperation: "inserted",
      completed: false,
      claimedGeneration: 4,
      currentConnectionStatus: "connected",
      currentConnectionGeneration: 4,
    }),
    false,
  );
  assert.equal(
    shouldCleanupInsertedCalendarEvent({
      externalOperation: "patched",
      completed: false,
      claimedGeneration: 4,
      currentConnectionStatus: "disconnected",
      currentConnectionGeneration: 5,
    }),
    false,
  );
});
