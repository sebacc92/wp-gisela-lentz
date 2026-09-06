import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createdAppointmentFromRpc,
  requestDepositAndNotify,
} from "./deposit-request.ts";

function requestClient(
  inspect: (body: Record<string, unknown>) => void,
): SupabaseClient {
  const settingsQuery = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async single() {
      return {
        data: {
          deposit_enabled: true,
          deposit_amount_ars: 10000,
          deposit_alias: "gisela.turnos",
          deposit_holder: "Gisela Lentz",
          deposit_request_message_template:
            "Seña {deposit_amount}. Alias {deposit_alias}. Titular {deposit_holder}.",
        },
        error: null,
      };
    },
  };
  return {
    async rpc() {
      return {
        data: { state: "synced", projectionStage: "pre_reservation" },
        error: null,
      };
    },
    from() {
      return settingsQuery;
    },
    functions: {
      async invoke(_name: string, options: { body?: unknown }) {
        inspect((options.body ?? {}) as Record<string, unknown>);
        return { data: { ok: true }, error: null };
      },
    },
  } as unknown as SupabaseClient;
}

test("extrae el turno creado tanto de objeto como de arreglo", () => {
  assert.deepEqual(
    createdAppointmentFromRpc({ id: "turno-1", deposit_status: "pending" }),
    { id: "turno-1", depositRequired: true },
  );
  assert.deepEqual(
    createdAppointmentFromRpc([
      { id: "turno-2", deposit_status: "not_required" },
    ]),
    { id: "turno-2", depositRequired: false },
  );
});

test("el pedido manual usa datos configurados e idempotencia estable", async () => {
  let body: Record<string, unknown> = {};
  const result = await requestDepositAndNotify(
    requestClient((value) => (body = value)),
    {
      appointmentId: "turno-1",
      contactId: "paciente-1",
      conversationId: "conversacion-1",
      depositRequired: true,
    },
  );

  assert.deepEqual(result, { required: true, notified: true });
  assert.equal(body.idempotencyKey, "deposit-request-turno-1");
  assert.equal(body.purpose, "operator_deposit_request");
  assert.equal(body.appointmentId, "turno-1");
  assert.equal(
    body.body,
    "Seña $10.000. Alias gisela.turnos. Titular Gisela Lentz.",
  );
});

test("si no requiere seña no intenta enviar", async () => {
  let invoked = false;
  const result = await requestDepositAndNotify(
    requestClient(() => (invoked = true)),
    {
      appointmentId: "turno-1",
      contactId: "paciente-1",
      depositRequired: false,
    },
  );

  assert.deepEqual(result, { required: false, notified: false });
  assert.equal(invoked, false);
});
