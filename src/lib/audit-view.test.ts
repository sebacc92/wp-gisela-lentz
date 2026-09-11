import assert from "node:assert/strict";
import test from "node:test";
import {
  auditTone,
  describeAuditAction,
  summarizeAuditMetadata,
  webhookTone,
} from "./audit-view.ts";

test("traduce las acciones conocidas", () => {
  assert.equal(
    describeAuditAction("deposit_confirmed"),
    "Se confirmó una seña",
  );
});

test("una acción desconocida se muestra tal cual", () => {
  assert.equal(
    describeAuditAction("algo_nuevo_2027"),
    "algo_nuevo_2027",
    "el registro existe para ver lo inesperado, no para ocultarlo",
  );
});

test("el tono distingue lo que revierte de lo que confirma", () => {
  assert.equal(auditTone("appointment_cancelled"), "danger");
  assert.equal(auditTone("google_calendar_disconnected"), "danger");
  assert.equal(auditTone("deposit_confirmed"), "success");
  assert.equal(auditTone("whatsapp_message_sent"), "neutral");
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

test("el resumen respeta el límite de campos", () => {
  const summary = summarizeAuditMetadata({ a: 1, b: 2, c: 3, d: 4, e: 5 }, 2);
  assert.equal(summary.split(" · ").length, 2);
});
