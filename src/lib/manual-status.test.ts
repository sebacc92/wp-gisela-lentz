import assert from "node:assert/strict";
import test from "node:test";

import {
  MANUAL_ROUTE,
  automationManualStatus,
  calendarManualStatus,
  manualSectionHref,
  manualSections,
  testModeManualStatus,
  webhookManualStatus,
  whatsappManualStatus,
} from "./manual-status.ts";

test("el estado de WhatsApp no presenta un dato desconocido como saludable", () => {
  assert.equal(
    whatsappManualStatus({
      checked: false,
      accountPresent: false,
      connected: false,
      sendingPaused: false,
      attentionRequired: false,
      tokenExpired: false,
      pendingJobs: 0,
      ambiguousJobs: 0,
    }).tone,
    "neutral",
  );
  assert.equal(
    whatsappManualStatus({
      checked: true,
      accountPresent: true,
      connected: true,
      sendingPaused: false,
      attentionRequired: false,
      tokenExpired: false,
      pendingJobs: 0,
      ambiguousJobs: 0,
    }).title,
    "WhatsApp está funcionando correctamente",
  );
  assert.equal(
    whatsappManualStatus({
      checked: true,
      accountPresent: true,
      connected: true,
      sendingPaused: false,
      attentionRequired: false,
      tokenExpired: false,
      pendingJobs: null,
      ambiguousJobs: 0,
    }).tone,
    "neutral",
  );
});

test("el estado simple cubre automatización, modo de envío y Calendar", () => {
  assert.equal(automationManualStatus(false).tone, "neutral");
  assert.match(automationManualStatus(null).title, /No pudimos comprobar/);
  assert.equal(testModeManualStatus(true).title, "Modo prueba activado");
  assert.equal(testModeManualStatus(null).tone, "neutral");
  assert.equal(
    calendarManualStatus({
      checked: true,
      configured: false,
      connected: false,
      status: "incomplete",
      pendingCount: 0,
      failedCount: 0,
    }).title,
    "Google Calendar todavía no está preparado",
  );
  assert.equal(
    calendarManualStatus({
      checked: true,
      configured: true,
      connected: true,
      status: "connected",
      pendingCount: null,
      failedCount: 0,
    }).tone,
    "neutral",
  );
  assert.equal(
    calendarManualStatus({
      checked: true,
      configured: true,
      connected: false,
      status: "error",
      pendingCount: 0,
      failedCount: 1,
    }).tone,
    "attention",
  );
  assert.equal(
    webhookManualStatus({
      checked: true,
      lastReceivedAt: "",
      failedCount: 1,
    }).tone,
    "attention",
  );
  assert.equal(
    webhookManualStatus({
      checked: false,
      lastReceivedAt: "2026-08-26T12:00:00.000Z",
      failedCount: 0,
    }).tone,
    "neutral",
  );
  assert.equal(
    webhookManualStatus({
      checked: true,
      lastReceivedAt: "2026-08-26T12:00:00.000Z",
      failedCount: null,
    }).tone,
    "neutral",
  );
  assert.equal(
    webhookManualStatus({
      checked: true,
      lastReceivedAt: "2026-01-01T00:00:00.000Z",
      failedCount: 0,
    }).tone,
    "neutral",
  );
});

test("las secciones y los enlaces contextuales usan destinos internos estables", () => {
  assert.ok(manualSections.some((section) => section.id === "turnos"));
  assert.ok(manualSections.some((section) => section.id === "whatsapp"));
  assert.equal(manualSectionHref("turnos"), `${MANUAL_ROUTE}#turnos`);
});
