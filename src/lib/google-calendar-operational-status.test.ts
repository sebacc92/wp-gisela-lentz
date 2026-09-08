import assert from "node:assert/strict";
import test from "node:test";
import {
  googleCalendarOperationalView,
  parseGoogleCalendarOperationalStatus,
} from "./google-calendar-operational-status.ts";

const readyResponse = {
  configured: true,
  connected: true,
  automationActive: true,
  lastSyncCompletedAt: "2026-09-05T14:30:00.000Z",
  pendingCount: 0,
  failedCount: 0,
  conflictCount: 0,
  firstImportApproved: true,
  inboundSyncState: "incremental",
  status: "connected",
};

test("el resumen operativo descarta identidad y sólo acepta conteos confiables", () => {
  const parsed = parseGoogleCalendarOperationalStatus({
    ...readyResponse,
    email: "privado@example.com",
    calendarName: "Agenda privada",
    eventSummary: "Dato que no debe conservarse",
  });

  assert.deepEqual(parsed, {
    configured: true,
    connected: true,
    automationActive: true,
    lastSuccessfulReviewAt: "2026-09-05T14:30:00.000Z",
    pendingCount: 0,
    failedCount: 0,
    conflictCount: 0,
    hasSyncError: false,
    firstImportApproved: true,
    inboundSyncState: "incremental",
    status: "connected",
  });
  assert.equal(JSON.stringify(parsed).includes("privado"), false);

  assert.equal(
    parseGoogleCalendarOperationalStatus({
      ...readyResponse,
      pendingCount: "0",
    }),
    null,
  );
  assert.equal(
    parseGoogleCalendarOperationalStatus({
      ...readyResponse,
      conflictCount: -1,
    }),
    null,
  );
  assert.equal(
    parseGoogleCalendarOperationalStatus({
      ...readyResponse,
      status: "estado_inventado",
    }),
    null,
  );
});

test("la automatización sólo queda activa ante true explícito del backend", () => {
  assert.equal(
    parseGoogleCalendarOperationalStatus({
      ...readyResponse,
      automationActive: undefined,
    })?.automationActive,
    false,
  );
  assert.equal(
    parseGoogleCalendarOperationalStatus({
      ...readyResponse,
      automationActive: "true",
    })?.automationActive,
    false,
  );
  assert.equal(
    parseGoogleCalendarOperationalStatus(readyResponse)?.automationActive,
    true,
  );
});

test("sólo un estado completo y automatizado se presenta al día", () => {
  const ready = parseGoogleCalendarOperationalStatus(readyResponse);
  assert.ok(ready);
  assert.equal(googleCalendarOperationalView(ready).kind, "healthy");
  assert.match(googleCalendarOperationalView(ready).title, /al día/);

  for (const response of [
    { ...readyResponse, automationActive: false },
    { ...readyResponse, lastSyncCompletedAt: null },
    { ...readyResponse, firstImportApproved: false },
    { ...readyResponse, inboundSyncState: "full_resync_required" },
  ]) {
    const parsed = parseGoogleCalendarOperationalStatus(response);
    assert.ok(parsed);
    const view = googleCalendarOperationalView(parsed);
    assert.notEqual(view.kind, "healthy");
    assert.doesNotMatch(view.title, /al día/);
  }
});

test("los conflictos explican que sincronizar no reemplaza la decisión humana", () => {
  const attention = parseGoogleCalendarOperationalStatus({
    ...readyResponse,
    pendingCount: 3,
    conflictCount: 1,
    automationActive: false,
  });
  assert.ok(attention);
  const view = googleCalendarOperationalView(attention);
  assert.equal(view.kind, "attention");
  assert.match(view.title, /1 cambio para revisar/);
  assert.match(view.detail, /Sincronizar no decide/);

  const pending = parseGoogleCalendarOperationalStatus({
    ...readyResponse,
    pendingCount: 2,
  });
  assert.ok(pending);
  assert.equal(googleCalendarOperationalView(pending).kind, "pending");
});
