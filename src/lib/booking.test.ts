import assert from "node:assert/strict";
import test from "node:test";
import {
  appointmentDisplayStatus,
  coverageAndDuration,
  effectiveDepositStatus,
} from "./booking.ts";

test("muestra los estados de seña con palabras simples", () => {
  assert.equal(
    appointmentDisplayStatus("scheduled", "pending"),
    "Esperando seña",
  );
  assert.equal(
    appointmentDisplayStatus("scheduled", "proof_received"),
    "Comprobante recibido",
  );
  assert.equal(
    appointmentDisplayStatus("confirmed", "confirmed"),
    "Confirmado",
  );
});

test("conserva como confirmado un turno legado sin seña requerida", () => {
  assert.equal(
    appointmentDisplayStatus("scheduled", "not_required"),
    "Confirmado",
  );
  assert.equal(
    appointmentDisplayStatus("completed", "not_required"),
    "Atendido",
  );
  assert.equal(
    appointmentDisplayStatus("cancelled", "not_required"),
    "Cancelado",
  );
});

test("deriva como vencida una reserva cuyo plazo terminó", () => {
  const now = Date.parse("2026-08-12T18:00:00.000Z");
  assert.equal(
    effectiveDepositStatus(
      "scheduled",
      "pending",
      "2026-08-12T17:59:59.000Z",
      now,
    ),
    "expired",
  );
  assert.equal(
    effectiveDepositStatus(
      "scheduled",
      "pending",
      "2026-08-12T18:00:01.000Z",
      now,
    ),
    "pending",
  );
  assert.equal(
    effectiveDepositStatus(
      "scheduled",
      "proof_received",
      "2026-08-12T17:59:59.000Z",
      now,
    ),
    "proof_received",
  );
});

test("la cobertura comunica la duración calculada", () => {
  assert.equal(coverageAndDuration("ioma", 30), "IOMA · 30 min");
  assert.equal(coverageAndDuration("particular", 60), "Particular · 60 min");
});
