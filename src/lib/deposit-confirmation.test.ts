import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { confirmDepositAndNotify } from "./deposit-confirmation.ts";

function confirmationClient(options?: {
  rpcFails?: boolean;
  sendThrows?: boolean;
  sentBody?: (body: Record<string, unknown>) => void;
}): SupabaseClient {
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async maybeSingle() {
      return { data: { id: "conversation-1" }, error: null };
    },
    async single() {
      return {
        data: {
          deposit_confirmed_message_template:
            "Confirmado para el {date} a las {time}.",
        },
        error: null,
      };
    },
  };

  return {
    async rpc() {
      return { data: null, error: options?.rpcFails ? new Error("RPC") : null };
    },
    from() {
      return query;
    },
    functions: {
      async invoke(_name: string, invokeOptions: { body?: unknown }) {
        if (options?.sendThrows) throw new Error("NETWORK");
        options?.sentBody?.(
          (invokeOptions.body ?? {}) as Record<string, unknown>,
        );
        return { data: { ok: true }, error: null };
      },
    },
  } as unknown as SupabaseClient;
}

const appointment = {
  appointmentId: "appointment-1",
  contactId: "contact-1",
  startsAt: "2026-08-14T13:30:00.000Z",
};

test("un fallo de WhatsApp no revierte una seña ya confirmada", async () => {
  const result = await confirmDepositAndNotify(
    confirmationClient({ sendThrows: true }),
    appointment,
  );

  assert.deepEqual(result, { confirmed: true, notified: false });
});

test("el aviso usa la plantilla y una idempotencia estable", async () => {
  let sentBody: Record<string, unknown> = {};
  const result = await confirmDepositAndNotify(
    confirmationClient({ sentBody: (value) => (sentBody = value) }),
    appointment,
  );

  assert.deepEqual(result, { confirmed: true, notified: true });
  assert.equal(sentBody.conversationId, "conversation-1");
  assert.equal(sentBody.idempotencyKey, "deposit-confirm-appointment-1");
  assert.equal(sentBody.purpose, "operator_deposit_confirmation");
  assert.equal(sentBody.appointmentId, "appointment-1");
  assert.match(String(sentBody.body), /viernes,? 14 de agosto/);
  assert.match(String(sentBody.body), /10:30/);
});

test("si la RPC falla no informa una confirmación inexistente", async () => {
  const result = await confirmDepositAndNotify(
    confirmationClient({ rpcFails: true }),
    appointment,
  );

  assert.deepEqual(result, { confirmed: false, notified: false });
});
