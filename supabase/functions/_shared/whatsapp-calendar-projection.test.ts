import assert from "node:assert/strict";
import test from "node:test";
import { assertOutboundPolicy } from "./whatsapp.ts";

function policyInput(
  source: string,
  projection: unknown,
  rpcError: unknown = null,
) {
  const conversation = {
    id: "conversation",
    contact_id: "patient",
    automation_mode: "auto" as const,
    last_inbound_message_at: new Date().toISOString(),
    needs_human: false,
  };
  const contact = {
    id: "patient",
    name: "Synthetic",
    phone_e164: "+12025550100",
    whatsapp_id: null,
    whatsapp_user_id: null,
  };
  const confirmation = source === "operator_deposit_confirmation";
  const rows: Record<string, unknown> = {
    conversations: conversation,
    contacts: contact,
    whatsapp_settings: { sending_paused: false },
    appointments: {
      id: "appointment",
      contact_id: "patient",
      status: confirmation ? "confirmed" : "scheduled",
      deposit_status: confirmation ? "confirmed" : "pending",
      hold_expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
  };
  const client = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: () => Promise.resolve({ data: rows[table], error: null }),
        maybeSingle: () => Promise.resolve({ data: rows[table], error: null }),
      };
      return chain;
    },
    rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "appointment_google_calendar_projection");
      assert.equal(args.p_appointment_id, "appointment");
      return Promise.resolve({ data: projection, error: rpcError });
    },
  } as unknown as Parameters<typeof assertOutboundPolicy>[0]["client"];
  return {
    client,
    conversation,
    contact,
    source,
    type: "text" as const,
    templateName: null,
    templateKey: null,
    appointmentId: "appointment",
    automationOwnerMessageId: null,
  };
}

test("el envío manual exige Calendar aun con seña válida y ventana WhatsApp abierta", async () => {
  for (const source of [
    "operator_deposit_request",
    "operator_deposit_confirmation",
  ]) {
    for (const state of ["pending", "unavailable", "conflict"]) {
      await assert.rejects(
        assertOutboundPolicy(policyInput(source, { state })),
        { message: "WHATSAPP_POLICY:CALENDAR_PROJECTION_PENDING" },
      );
    }
    await assert.rejects(
      assertOutboundPolicy(
        policyInput(
          source,
          { state: "synced", projectionStage: "confirmed" },
          { message: "db error" },
        ),
      ),
      { message: "WHATSAPP_POLICY:CALENDAR_PROJECTION_PENDING" },
    );
  }
});

test("un turno proyectado permite el aviso conservando las reglas normales de WhatsApp", async () => {
  for (const source of [
    "operator_deposit_request",
    "operator_deposit_confirmation",
  ]) {
    await assertOutboundPolicy(
      policyInput(source, {
        state: "synced",
        projectionStage:
          source === "operator_deposit_request"
            ? "pre_reservation"
            : "confirmed",
      }),
    );
  }
});

test("un cambio concurrente de etapa no permite confirmar una pre-reserva ni pedir seña ya confirmada", async () => {
  for (const source of [
    "operator_deposit_request",
    "operator_deposit_confirmation",
  ]) {
    await assert.rejects(
      assertOutboundPolicy(
        policyInput(source, {
          state: "synced",
          projectionStage:
            source === "operator_deposit_request"
              ? "confirmed"
              : "pre_reservation",
        }),
      ),
      { message: "WHATSAPP_POLICY:CALENDAR_PROJECTION_PENDING" },
    );
  }
});
