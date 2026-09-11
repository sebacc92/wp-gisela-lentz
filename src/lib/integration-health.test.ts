import assert from "node:assert/strict";
import test from "node:test";
import {
  integrationHealthAlerts,
  type WhatsAppHealthInput,
} from "./integration-health.ts";
import type { GoogleCalendarOperationalStatus } from "./google-calendar-operational-status.ts";

function whatsapp(
  overrides: Partial<WhatsAppHealthInput> = {},
): WhatsAppHealthInput {
  return {
    integrationStatus: "connected",
    lastError: null,
    sendingPaused: false,
    sendingPauseReason: null,
    ...overrides,
  };
}

function calendar(
  overrides: Partial<GoogleCalendarOperationalStatus> = {},
): GoogleCalendarOperationalStatus {
  return {
    configured: true,
    connected: true,
    automationActive: true,
    lastSuccessfulReviewAt: "2026-09-10T10:00:00.000Z",
    pendingCount: 0,
    failedCount: 0,
    conflictCount: 0,
    hasSyncError: false,
    firstImportApproved: true,
    inboundSyncState: "incremental",
    status: "connected",
    ...overrides,
  };
}

test("todo sano no genera ningún aviso", () => {
  assert.deepEqual(
    integrationHealthAlerts({
      whatsapp: whatsapp(),
      googleCalendar: calendar(),
    }),
    [],
  );
});

test("la integración en error es crítica y muestra el motivo guardado", () => {
  const [alert] = integrationHealthAlerts({
    whatsapp: whatsapp({
      integrationStatus: "error",
      lastError: "Falló la conexión o la validación con Meta",
    }),
    googleCalendar: calendar(),
  });
  assert.equal(alert.id, "whatsapp");
  assert.equal(alert.severity, "critical");
  assert.equal(alert.detail, "Falló la conexión o la validación con Meta");
  assert.equal(alert.adminOnly, true);
});

test("los envíos pausados se avisan aunque la conexión esté sana", () => {
  const [alert] = integrationHealthAlerts({
    whatsapp: whatsapp({
      sendingPaused: true,
      sendingPauseReason: "META_QUALITY_RED",
    }),
    googleCalendar: calendar(),
  });
  assert.equal(alert.severity, "critical");
  assert.match(alert.detail, /calidad del número a roja/i);
});

test("una instalación incompleta avisa sin alarmar", () => {
  const [alert] = integrationHealthAlerts({
    whatsapp: whatsapp({ integrationStatus: "incomplete" }),
    googleCalendar: calendar(),
  });
  assert.equal(alert.severity, "warning");
  assert.match(alert.detail, /agenda funciona igual/i);
});

test("Calendar desconectado pide volver a autorizar sin alarmar por la agenda", () => {
  const [alert] = integrationHealthAlerts({
    whatsapp: whatsapp(),
    googleCalendar: calendar({ connected: false, status: "disconnected" }),
  });
  assert.equal(alert.id, "google-calendar");
  assert.equal(alert.severity, "critical");
  assert.match(alert.detail, /agenda de la aplicación sigue disponible/i);
});

test("Calendar que nunca se configuró no molesta", () => {
  assert.deepEqual(
    integrationHealthAlerts({
      whatsapp: whatsapp(),
      googleCalendar: calendar({ configured: false, connected: false }),
    }),
    [],
  );
});

test("no poder leer el estado se informa, no se asume sano", () => {
  const alerts = integrationHealthAlerts({
    whatsapp: whatsapp({ integrationStatus: null }),
    googleCalendar: null,
  });
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every((alert) => alert.severity === "unknown"));
  assert.ok(
    alerts.every((alert) => alert.adminOnly === false),
    "no saber el estado no es una acción reservada a ADMIN",
  );
});

test("lo crítico se ordena antes que lo que sólo avisa", () => {
  const alerts = integrationHealthAlerts({
    whatsapp: whatsapp({ integrationStatus: "incomplete" }),
    googleCalendar: calendar({
      connected: false,
      status: "reconnect_required",
    }),
  });
  assert.equal(alerts[0].id, "google-calendar");
  assert.equal(alerts[0].severity, "critical");
  assert.equal(alerts[1].severity, "warning");
});

test("una resincronización completa pendiente sólo advierte", () => {
  const [alert] = integrationHealthAlerts({
    whatsapp: whatsapp(),
    googleCalendar: calendar({ inboundSyncState: "full_resync_required" }),
  });
  assert.equal(alert.severity, "warning");
});

test("sin Calendar en la entrada, el aviso sólo evalúa WhatsApp", () => {
  const alerts = integrationHealthAlerts({
    whatsapp: whatsapp({ integrationStatus: "error" }),
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, "whatsapp");
});

test("sin Calendar en la entrada no hay aviso de Calendar aunque falte el dato", () => {
  assert.deepEqual(
    integrationHealthAlerts({ whatsapp: whatsapp() }),
    [],
    "no evaluar no es lo mismo que no poder leer",
  );
});
