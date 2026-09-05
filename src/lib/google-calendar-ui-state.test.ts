import assert from "node:assert/strict";
import test from "node:test";
import {
  canRunManualGoogleCalendarSync,
  googleCalendarSyncStatus,
} from "./google-calendar-ui-state.ts";

const completedState = {
  status: "connected",
  firstImportApproved: true,
  inboundSyncState: "incremental",
  lastCheckedAt: "2026-09-05T04:45:00.000Z",
};

test("una conexión que espera aprobación no se presenta como al día", () => {
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      firstImportApproved: false,
      inboundSyncState: "awaiting_first_import",
      lastCheckedAt: "",
    }),
    "first_import",
  );
});

test("después de aprobar, la primera corrida sigue figurando pendiente", () => {
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      inboundSyncState: "awaiting_first_import",
      lastCheckedAt: "",
    }),
    "not_checked",
  );
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      status: "initial_sync_required",
      inboundSyncState: "full_resync_required",
      lastCheckedAt: "",
    }),
    "not_checked",
  );
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      lastCheckedAt: "fecha inválida",
    }),
    "not_checked",
  );
});

test("Todo al día exige aprobación, estado incremental y revisión válida", () => {
  assert.equal(googleCalendarSyncStatus(completedState), "synced");
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      inboundSyncState: "full_resync_required",
    }),
    "attention",
  );
  assert.equal(
    googleCalendarSyncStatus({ ...completedState, status: "desconocido" }),
    "attention",
  );
});

test("reconexión y sincronización en curso conservan prioridad", () => {
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      status: "reconnect_required",
      firstImportApproved: false,
    }),
    "reconnect",
  );
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      status: "pending",
      lastCheckedAt: "",
    }),
    "pending",
  );
});

test("la sincronización manual sólo se habilita al completar la importación", () => {
  assert.equal(
    canRunManualGoogleCalendarSync(false, "awaiting_first_import"),
    false,
  );
  assert.equal(
    canRunManualGoogleCalendarSync(true, "awaiting_first_import"),
    false,
  );
  assert.equal(canRunManualGoogleCalendarSync(true, "incremental"), true);
});
