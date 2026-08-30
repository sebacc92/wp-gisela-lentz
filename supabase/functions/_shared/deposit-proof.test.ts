import assert from "node:assert/strict";
import test from "node:test";

import {
  isDepositProofMediaType,
  normalizeDepositProofResult,
  validateDepositProofForAutoConfirmation,
} from "./deposit-proof.ts";

const APPOINTMENT_ID = "10000000-0000-4000-8000-000000000001";

test("sólo imagen y documento pueden iniciar el flujo de comprobante", () => {
  assert.equal(isDepositProofMediaType("image"), true);
  assert.equal(isDepositProofMediaType("document"), true);
  assert.equal(isDepositProofMediaType("text"), false);
});

test("tolera cero filas y un resultado explícitamente no reconocido", () => {
  assert.equal(normalizeDepositProofResult([]), null);
  assert.deepEqual(
    normalizeDepositProofResult([
      {
        appointment_id: null,
        recognized: false,
        late: false,
        acknowledge: false,
      },
    ]),
    {
      appointmentId: null,
      recognized: false,
      late: false,
      acknowledge: false,
    },
  );
});

test("reconoce un comprobante activo que necesita acuse", () => {
  assert.deepEqual(
    normalizeDepositProofResult([
      {
        appointment_id: APPOINTMENT_ID,
        late: false,
        acknowledge: true,
      },
    ]),
    {
      appointmentId: APPOINTMENT_ID,
      recognized: true,
      late: false,
      acknowledge: true,
    },
  );
});

test("un comprobante tardío nunca solicita respuesta automática", () => {
  assert.deepEqual(
    normalizeDepositProofResult({
      appointment_id: APPOINTMENT_ID,
      recognized: true,
      late: true,
      acknowledge: true,
    }),
    {
      appointmentId: APPOINTMENT_ID,
      recognized: true,
      late: true,
      acknowledge: false,
    },
  );
});

test("autoconfirma un comprobante legible con monto y destinatario básicos", () => {
  assert.deepEqual(
    validateDepositProofForAutoConfirmation({
      reading: {
        legible: true,
        amount: 10_000,
        currency: "ARS",
        date: "2026-08-30",
        destination: "odontologa.gisela.mp",
        holder: "Gisela Vanesa Lentz",
        operationId: "12345",
      },
      expectedAmountArs: 10_000,
      expectedAlias: "odontologa.gisela.mp",
      expectedHolder: "Gisela Vanesa Lentz",
    }),
    { approved: true, reasons: [] },
  );
});

test("exige monto exacto y destinatario aunque los demás datos sean opcionales", () => {
  const base = {
    legible: true,
    amount: 10_000,
    currency: "USD",
    date: "1900-01-01",
    destination: null,
    holder: "Gisela Vanesa Lentz",
    operationId: "dato-no-validado",
  };
  assert.equal(
    validateDepositProofForAutoConfirmation({
      reading: base,
      expectedAmountArs: 10_000,
      expectedAlias: "odontologa.gisela.mp",
      expectedHolder: "Gisela Vanesa Lentz",
    }).approved,
    true,
  );
  assert.deepEqual(
    validateDepositProofForAutoConfirmation({
      reading: { ...base, amount: 9_999.99 },
      expectedAmountArs: 10_000,
      expectedAlias: "odontologa.gisela.mp",
      expectedHolder: "Gisela Vanesa Lentz",
    }),
    {
      approved: false,
      reasons: ["AMOUNT_MISMATCH"],
    },
  );
  assert.deepEqual(
    validateDepositProofForAutoConfirmation({
      reading: { ...base, holder: "Otra persona" },
      expectedAmountArs: 10_000,
      expectedAlias: "odontologa.gisela.mp",
      expectedHolder: "Gisela Vanesa Lentz",
    }),
    {
      approved: false,
      reasons: ["RECIPIENT_MISMATCH"],
    },
  );
  assert.deepEqual(
    validateDepositProofForAutoConfirmation({
      reading: { ...base, holder: "Gisela" },
      expectedAmountArs: 10_000,
      expectedAlias: "odontologa.gisela.mp",
      expectedHolder: "Gisela Vanesa Lentz",
    }).reasons,
    ["RECIPIENT_MISMATCH"],
  );
});

test("tolera que el banco abrevie o reordene el titular", () => {
  for (const holder of ["GISELA V LENTZ", "LENTZ, GISELA"]) {
    assert.equal(
      validateDepositProofForAutoConfirmation({
        reading: {
          legible: true,
          amount: 10_000,
          currency: "ARS",
          date: null,
          destination: null,
          holder,
          operationId: null,
        },
        expectedAmountArs: 10_000,
        expectedAlias: "odontologa.gisela.mp",
        expectedHolder: "Gisela Vanesa Lentz",
      }).approved,
      true,
      holder,
    );
  }
});
