import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  confirmDepositAndNotify,
  depositConfirmationBody,
  renderDepositConfirmationMessage,
} from "./deposit-confirmation.ts";

function confirmationClient(options?: {
  rpcFails?: boolean;
  sendThrows?: boolean;
  template?: string;
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
            options?.template ??
            "Tu turno quedó confirmado para el {date} a las {time}.",
        },
        error: null,
      };
    },
  };

  return {
    async rpc(name: string) {
      if (name === "appointment_google_calendar_projection")
        return {
          data: { state: "synced", projectionStage: "confirmed" },
          error: null,
        };
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

test("una plantilla inválida usa una confirmación segura sin placeholders", () => {
  assert.equal(
    renderDepositConfirmationMessage(
      "Confirmé tu turno: {date} {placeholder_desconocido}",
      "viernes 14 de agosto",
      "10:30",
    ),
    "¡Listo! Tu turno quedó confirmado para el viernes 14 de agosto a las 10:30.",
  );
});

test("la confirmación suma la dirección y, en la franja cerrada, cómo avisar", () => {
  const template =
    "Tu turno quedó confirmado para el {date} a las {time}. Te esperamos en {address}.";
  // 16:00 UTC son las 13:00 en Buenos Aires: el centro está sin atención.
  const afternoon = depositConfirmationBody({
    template,
    startsAt: "2026-09-15T16:00:00.000Z",
    address: "Calle 11 1375",
  });
  assert.match(afternoon, /Calle 11 1375/);
  assert.match(afternoon, /2291-414102/);

  const morning = depositConfirmationBody({
    template,
    startsAt: "2026-09-15T13:00:00.000Z",
    address: "Calle 11 1375",
  });
  assert.match(morning, /Calle 11 1375/);
  assert.doesNotMatch(morning, /2291-414102/);
});

test("el aviso de la puerta también acompaña al texto por defecto", () => {
  const fallback = depositConfirmationBody({
    template: "{placeholder_inventado}",
    startsAt: "2026-09-15T16:00:00.000Z",
  });

  assert.match(fallback, /quedó confirmado/);
  assert.match(fallback, /2291-414102/);
});
