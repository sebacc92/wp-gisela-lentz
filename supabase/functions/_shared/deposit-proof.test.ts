import assert from "node:assert/strict";
import test from "node:test";

import {
  isDepositProofMediaType,
  normalizeDepositProofResult,
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
