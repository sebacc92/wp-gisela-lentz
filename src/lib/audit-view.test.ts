import assert from "node:assert/strict";
import test from "node:test";
import {
  auditTone,
  describeAuditAction,
  summarizeAuditMetadata,
  webhookTone,
} from "./audit-view.ts";

test("una acción desconocida se muestra tal cual", () => {
  assert.equal(
    describeAuditAction("algo_nuevo_2027"),
    "algo_nuevo_2027",
    "el registro existe para ver lo inesperado, no para ocultarlo",
  );
});

test("el tono distingue lo que revierte de lo que confirma", () => {
  assert.equal(auditTone("appointment.cancelled"), "danger");
  assert.equal(auditTone("deposit.confirmed"), "success");
  assert.equal(auditTone("message.operator_sent"), "neutral");
});

test("desconectado no se confunde con conectado", () => {
  assert.equal(auditTone("google_calendar.disconnected"), "danger");
  assert.equal(auditTone("google_calendar.connected"), "success");
});

test("una falla o un error se marcan como peligro", () => {
  assert.equal(auditTone("whatsapp.embedded_signup.failed"), "danger");
  assert.equal(auditTone("whatsapp.business_token.validation_error"), "danger");
});

test("el estado del webhook marca fallas y pendientes", () => {
  assert.equal(webhookTone("failed"), "danger");
  assert.equal(webhookTone("pending"), "warning");
  assert.equal(webhookTone("processed"), "success");
  assert.equal(webhookTone("lo_que_sea"), "neutral");
});

test("el resumen de metadata omite objetos y recorta lo largo", () => {
  const summary = summarizeAuditMetadata({
    appointment_id: "abc",
    nested: { no: "deberia" },
    note: "x".repeat(60),
  });
  assert.match(summary, /appointment_id: abc/);
  assert.doesNotMatch(summary, /nested/);
  assert.match(summary, /…/);
});

test("una fecha ISO se muestra en la zona del consultorio", () => {
  const summary = summarizeAuditMetadata({
    starts_at: "2026-09-12T12:00:00+00:00",
  });
  // 12:00 UTC son las 09:00 en Buenos Aires.
  assert.match(summary, /starts_at: 12\/9\/26,? 09:00/);
  assert.doesNotMatch(summary, /T12:00/);
});

test("el resumen respeta el límite de campos", () => {
  const summary = summarizeAuditMetadata({ a: 1, b: 2, c: 3, d: 4, e: 5 }, 2);
  assert.equal(summary.split(" · ").length, 2);
});

test("traduce el vocabulario real, con punto como separador", () => {
  assert.equal(
    describeAuditAction("deposit.confirmed"),
    "Se confirmó una seña",
  );
  assert.equal(describeAuditAction("appointment.created"), "Se creó un turno");
  assert.equal(
    describeAuditAction("whatsapp.automations_toggled"),
    "Se encendió o apagó la automatización",
  );
});

test("el vocabulario inventado con guion bajo ya no se traduce", () => {
  // Existió una primera versión con claves como `deposit_confirmed` que el
  // sistema nunca escribe: la mayoría de las entradas quedaban sin traducir.
  assert.equal(describeAuditAction("deposit_confirmed"), "deposit_confirmed");
});
