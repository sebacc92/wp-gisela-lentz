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
  lastSyncCompletedAt: "2026-09-05T04:45:00.000Z",
  automationActive: true,
};

test("una conexión que espera aprobación no se presenta como al día", () => {
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      firstImportApproved: false,
      inboundSyncState: "awaiting_first_import",
      lastSyncCompletedAt: "",
    }),
    "first_import",
  );
});

test("después de aprobar, la primera corrida sigue figurando pendiente", () => {
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      inboundSyncState: "awaiting_first_import",
      lastSyncCompletedAt: "",
    }),
    "not_checked",
  );
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      status: "initial_sync_required",
      inboundSyncState: "full_resync_required",
      lastSyncCompletedAt: "",
    }),
    "not_checked",
  );
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      lastSyncCompletedAt: "fecha inválida",
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

test("una revisión manual no permite inferir automatización activa", () => {
  assert.equal(
    googleCalendarSyncStatus({
      ...completedState,
      automationActive: false,
    }),
    "inactive",
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
      lastSyncCompletedAt: "",
    }),
    "pending",
  );
});

test("la sincronización manual sólo se habilita al completar la importación", () => {
  assert.equal(
    canRunManualGoogleCalendarSync(false, "awaiting_first_import", true),
    false,
  );
  assert.equal(
    canRunManualGoogleCalendarSync(true, "awaiting_first_import", true),
    false,
  );
  assert.equal(canRunManualGoogleCalendarSync(true, "incremental", true), true);
  assert.equal(
    canRunManualGoogleCalendarSync(true, "incremental", false),
    false,
  );
});
